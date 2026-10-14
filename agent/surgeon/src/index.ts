import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecisions } from "@stale-flags/local-store";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const MAX_ATTEMPTS = 4;
const MAX_LINE_DELTA = 0.65;
const FLAG_KEY_RE = /^[a-z0-9_]+$/;

type Payload = {
  flag_key: string;
  verdict: string;
  reason: string;
  route?: string;
  target_value: string;
  collapse_direction: "keep_gated_branch" | "delete_gated_branch" | "none";
  evidence: Record<string, unknown>;
  run_id: string;
  datafile_revision?: string;
};

function parsePayload(): Payload {
  const argv = process.argv.filter((a) => a !== "--");
  const arg = argv.find((a) => a.startsWith("--payload="));
  const flagArg = argv.find((a) => a.startsWith("--flag="));
  if (arg) {
    return JSON.parse(
      Buffer.from(arg.slice("--payload=".length), "base64url").toString("utf8"),
    ) as Payload;
  }
  if (flagArg) {
    const key = flagArg.slice("--flag=".length);
    if (!FLAG_KEY_RE.test(key)) throw new Error(`Invalid flag_key: ${key}`);
    return {
      flag_key: key,
      verdict: "safe_to_remove",
      reason: "manual",
      target_value: key === "promo_banner_2025" ? "false" : "true",
      collapse_direction:
        key === "promo_banner_2025" ? "delete_gated_branch" : "keep_gated_branch",
      evidence: {},
      run_id: "manual",
    };
  }
  throw new Error("Provide --payload=… or --flag=");
}

function assertFlagKey(flagKey: string): void {
  if (!FLAG_KEY_RE.test(flagKey)) {
    throw new Error(`Invalid flag_key (must match ${FLAG_KEY_RE}): ${flagKey}`);
  }
}

function runCaptured(
  cmd: string,
  args: string[],
): { ok: boolean; log: string; status: number | null; error?: Error } {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
  return {
    ok: r.status === 0,
    log,
    status: r.status,
    error: r.error,
  };
}

function run(cmd: string, args: string[]): boolean {
  return runCaptured(cmd, args).ok;
}

function fallbackBody(payload: Payload): string {
  return `## Flag cleanup: \`${payload.flag_key}\`

**Verdict:** ${payload.verdict}
**Collapse:** ${payload.collapse_direction} (target_value=${payload.target_value})
**Run:** ${payload.run_id}

${payload.reason}

### Evidence
\`\`\`json
${JSON.stringify(payload.evidence, null, 2)}
\`\`\`

Gates: tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist.
`;
}

function assertRgOk(grep: {
  error?: Error;
  status: number | null;
  stderr?: string | null;
}): void {
  if (grep.error || grep.status === 127) {
    throw new Error(
      `ripgrep (rg) is required but missing: ${grep.error?.message ?? `status ${grep.status}`}`,
    );
  }
  // 0 = matches, 1 = no matches; anything else is a hard failure (do not fail-open)
  if (grep.status !== 0 && grep.status !== 1) {
    throw new Error(
      `ripgrep failed with status ${grep.status}: ${grep.stderr ?? ""}`,
    );
  }
}

function findReferenceFiles(flagKey: string): string[] {
  // Only app call sites. packages/* may mention flag keys in unit fixtures
  // (e.g. verdicts tests) and must not be edited by the surgeon.
  const grep = spawnSync("rg", ["-l", flagKey, "apps"], {
    cwd: root,
    encoding: "utf8",
  });
  assertRgOk(grep);
  if (grep.status === 1) return [];
  return (grep.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rel) => path.join(root, rel));
}

function flagStillReferenced(flagKey: string): string {
  // App + Featurevisor definitions only. Skip packages/ (test fixtures) and
  // built datafiles that still embed the removed key until republish.
  const grep = spawnSync(
    "rg",
    [
      "-n",
      flagKey,
      "apps",
      "featurevisor/features",
      "featurevisor/tests",
      "-g",
      "!datafiles/**",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assertRgOk(grep);
  // status 1 = no matches (clean), 0 = matches found
  if (grep.status === 1) return "";
  return (grep.stdout || "").trim();
}

function listDirtyPaths(): string[] {
  const tracked = runCaptured("git", ["diff", "--name-only"]);
  const untracked = runCaptured("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const lines = `${tracked.log}\n${untracked.log}`
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

function securityCheck(changed: string[]): { ok: boolean; detail: string } {
  const allowedPrefixes = [
    "apps/web/src/",
    "featurevisor/features/",
    "featurevisor/tests/features/",
    "featurevisor/.featurevisor/",
  ];
  const denied = ["tinybird/", "agent/", "infra/", "tools/", ".github/"];
  for (const f of changed) {
    const rel = f.replace(/\\/g, "/");
    if (denied.some((d) => rel.startsWith(d))) {
      return { ok: false, detail: `denied path ${rel}` };
    }
    if (!allowedPrefixes.some((a) => rel.startsWith(a))) {
      return { ok: false, detail: `path not allowlisted ${rel}` };
    }
  }
  return { ok: true, detail: "allowlist ok" };
}

function lineCount(src: string): number {
  return src.split("\n").length;
}

function maxLineDelta(
  originals: Map<string, string>,
): { ok: boolean; detail: string } {
  for (const [file, original] of originals) {
    if (!existsSync(file)) {
      // YAML deletes are expected and tracked separately
      if (file.includes("featurevisor/")) continue;
      return { ok: false, detail: `file deleted ${path.relative(root, file)}` };
    }
    const current = readFileSync(file, "utf8");
    const before = lineCount(original);
    const after = lineCount(current);
    if (before > 0 && after / before < 1 - MAX_LINE_DELTA) {
      return {
        ok: false,
        detail: `${path.relative(root, file)} shrank from ${before} to ${after} lines (>${Math.round(MAX_LINE_DELTA * 100)}% deletion)`,
      };
    }
  }
  return { ok: true, detail: "delta ok" };
}

function deleteYaml(flagKey: string): string[] {
  const changed: string[] = [];
  const feature = path.join(root, "featurevisor/features", `${flagKey}.yml`);
  const test = path.join(
    root,
    "featurevisor/tests/features",
    `${flagKey}.spec.yml`,
  );
  if (existsSync(feature)) {
    unlinkSync(feature);
    changed.push(path.relative(root, feature));
  }
  if (existsSync(test)) {
    unlinkSync(test);
    changed.push(path.relative(root, test));
  }
  return changed;
}

function extractCodeBlock(text: string): string | null {
  const fence = text.match(/```(?:tsx|ts|jsx|js|typescript|javascript)?\n([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].replace(/\n$/, "");
  // Whole response is the file
  if (text.includes("export ") || text.includes("import ")) {
    return text.trim();
  }
  return null;
}

function bedrockModelId(): string {
  return (
    process.env.BEDROCK_MODEL_ID ??
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
  );
}

async function converseEdit(opts: {
  flagKey: string;
  collapse: Payload["collapse_direction"];
  targetValue: string;
  files: Array<{ path: string; content: string }>;
  lastError: string;
  attempt: number;
}): Promise<Array<{ path: string; content: string }>> {
  const region = process.env.AWS_REGION ?? process.env.AWS_REGION_NAME ?? "us-east-1";
  const client = new BedrockRuntimeClient({
    region,
    requestHandler: undefined,
  });

  const fileBlocks = opts.files
    .map(
      (f) =>
        `### FILE: ${f.path}\n\`\`\`tsx\n${f.content}\n\`\`\``,
    )
    .join("\n\n");

  const system = `You are a precise TypeScript/React code editor removing a Featurevisor feature flag.
Rules:
- Remove every reference to flag_key "${opts.flagKey}" (useFlag("${opts.flagKey}"), FlagCallout with that flagKey, string literals of the key).
- collapse_direction=${opts.collapse}. target_value=${opts.targetValue}.
  - keep_gated_branch: keep the enabled/true branch of conditionals; delete the disabled/false branch and the flag plumbing.
  - delete_gated_branch: keep the disabled/false branch (or remove gated UI entirely if it only renders when enabled); delete the enabled branch and flag plumbing.
- Remove unused imports (FlagCallout, useFlag) ONLY when no other flag in that file still needs them.
- Do NOT modify other flags in the same file.
- Do NOT invent new features, comments, or rewrite unrelated code.
- Return ONE fenced code block per file, each preceded by a line: ### FILE: <relative/path>
- Output nothing else.`;

  const userText =
    opts.attempt === 1
      ? `Edit these files to remove flag ${opts.flagKey}.\n\n${fileBlocks}`
      : `Previous edit failed gates (attempt ${opts.attempt}/${MAX_ATTEMPTS}). Fix the CURRENT file contents below using this compiler/rg error:\n\n${opts.lastError}\n\nCurrent files:\n\n${fileBlocks}`;

  const messages: Message[] = [
    { role: "user", content: [{ text: userText }] },
  ];

  const cmd = new ConverseCommand({
    modelId: bedrockModelId(),
    system: [{ text: system }],
    messages,
    inferenceConfig: { maxTokens: 8192, temperature: 0 },
  });

  const res = await client.send(cmd);
  const text = (res.output?.message?.content ?? [])
    .map((c) => ("text" in c && c.text ? c.text : ""))
    .join("\n");

  const edits: Array<{ path: string; content: string }> = [];
  const parts = text.split(/^### FILE:\s*/m).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const rel = (nl === -1 ? part : part.slice(0, nl)).trim();
    const body = nl === -1 ? "" : part.slice(nl + 1);
    const code = extractCodeBlock(body);
    if (!rel || !code) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    edits.push({ path: abs, content: code });
  }

  if (edits.length === 0 && opts.files.length === 1) {
    const code = extractCodeBlock(text);
    if (code) edits.push({ path: opts.files[0]!.path, content: code });
  }

  if (edits.length === 0) {
    throw new Error(
      `Bedrock returned no file edits. Raw response head: ${text.slice(0, 400)}`,
    );
  }
  return edits;
}

/** Deterministic fallback when Bedrock is unavailable (local demos). */
function applyHeuristicEdits(
  payload: Payload,
  files: string[],
): void {
  for (const file of files) {
    let src = readFileSync(file, "utf8");
    const key = payload.flag_key;
    if (payload.collapse_direction === "delete_gated_branch") {
      // Drop useFlag line, FlagCallout block, and simple enabled ternaries for this flag
      src = src.replace(
        new RegExp(
          `\\s*const\\s+\\w+\\s*=\\s*useFlag\\("${key}"\\);\\n`,
          "g",
        ),
        "\n",
      );
      src = src.replace(
        new RegExp(
          `\\s*\\{[\\w.]+\\.enabled\\s*\\?\\s*\\([\\s\\S]*?\\)\\s*:\\s*null\\}\\s*`,
          "g",
        ),
        "\n",
      );
      src = src.replace(
        new RegExp(
          `\\s*<FlagCallout[\\s\\S]*?flagKey="${key}"[\\s\\S]*?/>\\s*`,
          "g",
        ),
        "\n",
      );
      // If Listing became import-only unused, strip FlagCallout/useFlag imports when unused
      if (!src.includes("useFlag(") && !src.includes("<FlagCallout")) {
        src = src.replace(
          /import\s*\{\s*FlagCallout\s*\}\s*from\s*["'][^"']+["'];\n?/,
          "",
        );
        src = src.replace(
          /import\s*\{\s*useFlag\s*\}\s*from\s*["'][^"']+["'];\n?/,
          "",
        );
      }
    } else if (payload.collapse_direction === "keep_gated_branch") {
      const varMatch = src.match(
        new RegExp(`const\\s+(\\w+)\\s*=\\s*useFlag\\("${key}"\\);`),
      );
      const varName = varMatch?.[1];
      if (varName) {
        src = src.replace(
          new RegExp(`\\s*const\\s+${varName}\\s*=\\s*useFlag\\("${key}"\\);\\n`),
          "\n",
        );
        // Keep enabled branch of ternary: {var.enabled ? (A) : (B)} -> A
        src = src.replace(
          new RegExp(
            `\\{${varName}\\.enabled\\s*\\?\\s*\\(([\\s\\S]*?)\\)\\s*:\\s*\\([\\s\\S]*?\\)\\}`,
          ),
          "$1",
        );
        src = src.replace(
          new RegExp(
            `\\s*<FlagCallout[\\s\\S]*?flagKey="${key}"[\\s\\S]*?/>\\s*`,
          ),
          "\n",
        );
        if (!src.includes("useFlag(") && !src.includes("<FlagCallout")) {
          src = src.replace(
            /import\s*\{\s*FlagCallout\s*\}\s*from\s*["'][^"']+["'];\n?/,
            "",
          );
          src = src.replace(
            /import\s*\{\s*useFlag\s*\}\s*from\s*["'][^"']+["'];\n?/,
            "",
          );
        } else if (!src.includes("<FlagCallout")) {
          src = src.replace(
            /import\s*\{\s*FlagCallout\s*\}\s*from\s*["'][^"']+["'];\n?/,
            "",
          );
        }
      }
    }
    writeFileSync(file, src);
  }
}

async function editLoop(payload: Payload, files: string[]): Promise<{
  ok: boolean;
  gateLog: string;
}> {
  const originals = new Map(
    files.filter((f) => existsSync(f)).map((f) => [f, readFileSync(f, "utf8")]),
  );
  let gateLog = "";
  const useBedrock = process.env.BEDROCK_DISABLED !== "1";
  let usedHeuristic = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Surgeon edit attempt ${attempt}/${MAX_ATTEMPTS}`);
    try {
      if (useBedrock && !usedHeuristic) {
        const current = files
          .filter((f) => existsSync(f))
          .map((f) => ({
            path: path.relative(root, f),
            content: readFileSync(f, "utf8"),
          }));
        const edits = await converseEdit({
          flagKey: payload.flag_key,
          collapse: payload.collapse_direction,
          targetValue: payload.target_value,
          files: current,
          lastError: gateLog,
          attempt,
        });
        const allowed = new Set(files.map((f) => path.resolve(f)));
        for (const e of edits) {
          const abs = path.resolve(
            path.isAbsolute(e.path) ? e.path : path.join(root, e.path),
          );
          if (!allowed.has(abs)) {
            gateLog = `rewound: model tried to edit non-target file ${path.relative(root, abs)}`;
            for (const [f, src] of originals) writeFileSync(f, src);
            throw new Error(gateLog);
          }
          writeFileSync(abs, e.content);
        }
      } else {
        applyHeuristicEdits(payload, files);
      }
    } catch (err) {
      gateLog = err instanceof Error ? err.message : String(err);
      console.warn(`Edit attempt ${attempt} model error: ${gateLog}`);
      if (!usedHeuristic && attempt === 1) {
        console.warn("Falling back to heuristic edits");
        usedHeuristic = true;
        applyHeuristicEdits(payload, files);
      } else {
        continue;
      }
    }

    const delta = maxLineDelta(originals);
    if (!delta.ok) {
      for (const [f, src] of originals) writeFileSync(f, src);
      gateLog = `rewind: ${delta.detail}. Apply a minimal diff.`;
      continue;
    }

    const dirty = listDirtyPaths();
    const sec = securityCheck(dirty);
    if (!sec.ok) {
      for (const [f, src] of originals) writeFileSync(f, src);
      gateLog = `rewind: ${sec.detail}`;
      // Guardrail breach: stop immediately
      return { ok: false, gateLog };
    }

    const fvBuild = runCaptured("pnpm", [
      "--filter",
      "@stale-flags/featurevisor",
      "build",
    ]);
    const leftover = flagStillReferenced(payload.flag_key);
    const tsc = runCaptured("pnpm", [
      "--filter",
      "@stale-flags/web",
      "typecheck",
    ]);
    const vite = runCaptured("pnpm", [
      "--filter",
      "@stale-flags/web",
      "build",
    ]);
    const fvLint = runCaptured("pnpm", [
      "--filter",
      "@stale-flags/featurevisor",
      "lint",
    ]);
    const fvTest = runCaptured("pnpm", [
      "--filter",
      "@stale-flags/featurevisor",
      "test",
    ]);

    if (leftover) {
      for (const [f, src] of originals) writeFileSync(f, src);
      gateLog = `Flag key still referenced:\n${leftover}`;
      console.warn(`Attempt ${attempt} gate fail: leftover references`);
      continue;
    }
    if (!fvBuild.ok || !tsc.ok || !vite.ok || !fvLint.ok || !fvTest.ok) {
      for (const [f, src] of originals) writeFileSync(f, src);
      gateLog = [
        !fvBuild.ok ? `featurevisor build:\n${fvBuild.log}` : "",
        !tsc.ok ? `tsc:\n${tsc.log}` : "",
        !vite.ok ? `vite build:\n${vite.log}` : "",
        !fvLint.ok ? `featurevisor lint:\n${fvLint.log}` : "",
        !fvTest.ok ? `featurevisor test:\n${fvTest.log}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      console.warn(
        `Attempt ${attempt} gate fail: ${gateLog.slice(0, 500).replace(/\n/g, " | ")}`,
      );
      continue;
    }

    console.log(`Attempt ${attempt}: gates passed`);
    return { ok: true, gateLog: "gates passed" };
  }

  console.error(`Surgeon exhausted attempts: ${gateLog.slice(0, 2000)}`);
  return { ok: false, gateLog: gateLog || "exhausted attempts" };
}

async function ensurePr(opts: {
  repo: string;
  demoBranch: string;
  workBranch: string;
  title: string;
  body: string;
}): Promise<string> {
  const env = { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN };
  const existing = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      opts.repo,
      "--head",
      opts.workBranch,
      "--base",
      opts.demoBranch,
      "--json",
      "url",
      "--jq",
      ".[0].url // empty",
    ],
    { cwd: root, encoding: "utf8", env },
  );
  const url = (existing.stdout || "").trim();
  if (url) {
    console.log(`Reusing existing PR ${url}`);
    return url;
  }
  const created = spawnSync(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      opts.repo,
      "--base",
      opts.demoBranch,
      "--head",
      opts.workBranch,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    { cwd: root, encoding: "utf8", env },
  );
  if (created.status !== 0) {
    throw new Error(
      `gh pr create failed: ${created.stderr || created.stdout}`,
    );
  }
  return (created.stdout || "").trim();
}

async function main(): Promise<void> {
  const argv = process.argv.filter((a) => a !== "--");
  const dryRun = argv.includes("--dry-run");
  const payload = parsePayload();
  assertFlagKey(payload.flag_key);
  if (payload.collapse_direction === "none") {
    throw new Error("Refusing collapse_direction=none");
  }

  const demoBranch = process.env.DEMO_BRANCH ?? "demo";
  const workBranch = `agent/remove-${payload.flag_key}`;
  console.log(
    `Surgeon ${payload.flag_key} collapse=${payload.collapse_direction} dryRun=${dryRun}`,
  );

  if (dryRun) {
    const files = findReferenceFiles(payload.flag_key);
    console.log("Would remove YAML + edit:");
    console.log(`  featurevisor/features/${payload.flag_key}.yml`);
    console.log(`  featurevisor/tests/features/${payload.flag_key}.spec.yml`);
    for (const f of files) console.log(`  ${path.relative(root, f)}`);
    console.log("\n--- PR body preview ---\n");
    console.log(fallbackBody(payload));
    return;
  }

  const restore = (): void => {
    run("git", ["reset", "--hard", "HEAD"]);
    run("git", ["clean", "-fd"]);
    run("git", ["checkout", demoBranch]);
  };

  if (process.env.GITHUB_TOKEN) {
    if (!run("git", ["fetch", "origin", demoBranch])) {
      throw new Error(`git fetch origin ${demoBranch} failed`);
    }
    if (!run("git", ["checkout", demoBranch])) {
      throw new Error(`git checkout ${demoBranch} failed`);
    }
    if (!run("git", ["reset", "--hard", `origin/${demoBranch}`])) {
      throw new Error(`git reset --hard origin/${demoBranch} failed`);
    }
    if (!run("git", ["checkout", "-B", workBranch])) {
      throw new Error(`git checkout -B ${workBranch} failed`);
    }
  }

  deleteYaml(payload.flag_key);
  let files: string[] = [];
  try {
    files = findReferenceFiles(payload.flag_key);
  } catch (err) {
    await appendDecisions([
      {
        decided_at: new Date().toISOString(),
        run_id: payload.run_id,
        flag_key: payload.flag_key,
        verdict: "failed",
        route: "surgeon_guardrail_breach",
        reason: err instanceof Error ? err.message : String(err),
        evidence: JSON.stringify(payload.evidence),
        pr_url: "",
        datafile_revision: payload.datafile_revision ?? "",
      },
    ]);
    restore();
    throw err;
  }
  if (files.length === 0) {
    console.log("No app/package call sites found; YAML-only removal");
  }

  const { ok, gateLog } = await editLoop(payload, files);
  if (!ok) {
    console.error(`Surgeon failed for ${payload.flag_key}: ${gateLog.slice(0, 2000)}`);
    await appendDecisions([
      {
        decided_at: new Date().toISOString(),
        run_id: payload.run_id,
        flag_key: payload.flag_key,
        verdict: "failed",
        route: gateLog.startsWith("rewind: denied") ||
          gateLog.startsWith("rewind: path")
          ? "surgeon_guardrail_breach"
          : "surgeon_gate_exhausted",
        reason: gateLog.slice(0, 4000),
        evidence: JSON.stringify({
          ...payload.evidence,
          attempts: MAX_ATTEMPTS,
        }),
        pr_url: "",
        datafile_revision: payload.datafile_revision ?? "",
      },
    ]);
    restore();
    process.exit(1);
  }

  const body = fallbackBody(payload);
  mkdirSync(path.join(root, ".local-data"), { recursive: true });
  const localPr = path.join(root, `.local-data/pr-${payload.flag_key}.md`);
  writeFileSync(localPr, body);

  let prUrl = `file://.local-data/pr-${payload.flag_key}.md`;
  if (process.env.GITHUB_TOKEN) {
    const dirty = listDirtyPaths().filter(
      (p) =>
        p.startsWith("apps/") ||
        p.startsWith("featurevisor/features/") ||
        p.startsWith("featurevisor/tests/") ||
        p.startsWith("featurevisor/.featurevisor/"),
    );
    if (dirty.length === 0) {
      restore();
      throw new Error("No staged changes after successful gates");
    }
    run("git", ["add", ...dirty]);
    if (
      !run("git", [
        "commit",
        "-m",
        `remove flag ${payload.flag_key} (${payload.collapse_direction})`,
      ])
    ) {
      restore();
      throw new Error("git commit failed");
    }
    if (!run("git", ["push", "-u", "origin", workBranch, "--force"])) {
      restore();
      throw new Error("git push failed");
    }
    try {
      prUrl = await ensurePr({
        repo: process.env.GITHUB_REPO ?? "lucamezzalira/stale-flag-cleanup",
        demoBranch,
        workBranch,
        title: `Remove feature flag ${payload.flag_key}`,
        body,
      });
    } catch (err) {
      console.error(err);
      // Branch is already pushed; do not hard-reset remote. Just leave local on demo.
      run("git", ["checkout", demoBranch]);
      throw err;
    }
    run("git", ["checkout", demoBranch]);
  } else {
    console.log(`No GITHUB_TOKEN — wrote ${localPr}`);
  }

  await appendDecisions([
    {
      decided_at: new Date().toISOString(),
      run_id: payload.run_id,
      flag_key: payload.flag_key,
      verdict: "safe_to_remove",
      route: payload.route ?? "lifecycle",
      reason: payload.reason,
      evidence: JSON.stringify(payload.evidence),
      pr_url: prUrl,
      datafile_revision: payload.datafile_revision ?? "",
    },
  ]);
  console.log(prUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
