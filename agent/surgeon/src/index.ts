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
import { appendDecisions, loadDotEnvOnce } from "@stale-flags/local-store";
import {
  checkDiffSubstance,
  GATES_LINE,
} from "./diff-substance.js";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const MAX_ATTEMPTS = 4;
const MAX_LINE_DELTA = 0.65;
const FLAG_KEY_RE = /^[a-z0-9_]+$/;
const MCP_ALLOWED_ENDPOINTS = ["flag_safety_check", "cleanup_report"] as const;
const MAX_MCP_TOOL_CALLS = 4;
const MCP_EVIDENCE_TIMEOUT_MS = 90_000;

type SafetyCheckRow = {
  flag_key: string;
  verdict: string;
  route?: string;
  reason?: string;
  collapse_direction: string;
  target_value?: string;
  evaluated_events?: number;
  blocked_events?: number;
  evaluating_share?: number;
  datafile_revision?: string;
};

/** Format evaluating_share (0..1) as a percentage for model-facing narratives. */
function formatEvaluatingSharePct(share: number | undefined): string {
  if (share === undefined || share === null || !Number.isFinite(share)) {
    return "n/a";
  }
  const pct = share * 100;
  if (pct <= 0) return "0%";
  if (Math.abs(pct - Math.round(pct)) < 0.05) return `${Math.round(pct)}%`;
  return `${pct.toFixed(1)}%`;
}

function evidenceDisplayRows(decisions: SafetyCheckRow[]) {
  return decisions.map((d) => ({
    flag_key: d.flag_key,
    evaluated_events: d.evaluated_events ?? 0,
    blocked_events: d.blocked_events ?? 0,
    evaluating_share: d.evaluating_share ?? 0,
    evaluating_share_pct: formatEvaluatingSharePct(d.evaluating_share),
    route: d.route,
    target_value: d.target_value,
    datafile_revision: d.datafile_revision,
  }));
}

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
    const collapseArg = argv.find((a) => a.startsWith("--collapse="));
    const targetArg = argv.find((a) => a.startsWith("--target="));
    const collapse = (collapseArg?.slice("--collapse=".length) ??
      "keep_gated_branch") as Payload["collapse_direction"];
    const target_value =
      targetArg?.slice("--target=".length) ??
      (collapse === "delete_gated_branch" ? "false" : "true");
    return {
      flag_key: key,
      verdict: "safe_to_remove",
      reason: "manual",
      target_value,
      collapse_direction: collapse,
      evidence: {},
      run_id: "manual",
    };
  }
  throw new Error("Provide --payload=…, --plan-s3=…, or --flag= with --collapse=");
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

function decisionSection(
  runIdValue: string,
  decisions: SafetyCheckRow[],
  gatesLine: string,
): string {
  const blocks = decisions.map((d) => {
    const events =
      d.evaluated_events === undefined || d.evaluated_events === null
        ? "n/a"
        : String(d.evaluated_events);
    return `### \`${d.flag_key}\`
- **Verdict:** ${d.verdict}
- **Route:** ${d.route ?? "n/a"}
- **Reason:** ${d.reason ?? ""}
- **Collapse:** ${d.collapse_direction} (target_value=${d.target_value ?? ""})
- **Evaluated events:** ${events}`;
  });
  return `## Decision (harness)

Authoritative safety decision from Tinybird REST \`flag_safety_check\` re-verify. The model does not supply or alter this section.

**Run:** ${runIdValue}
**Gates:** ${gatesLine}

${blocks.join("\n\n")}
`;
}

function buildPrBody(opts: {
  runIdValue: string;
  titleLine: string;
  decisions: SafetyCheckRow[];
  evidenceNarrative: string;
  mcpStatus: "ok" | "unavailable";
  gatesLine?: string;
}): string {
  const gates =
    opts.gatesLine ??
    GATES_LINE;
  const decision = decisionSection(opts.runIdValue, opts.decisions, gates);
  const stamp = new Date().toISOString();
  const footer =
    opts.mcpStatus === "ok"
      ? `\n\n_Retrieved via Tinybird MCP at ${stamp}. Endpoints: ${MCP_ALLOWED_ENDPOINTS.join(", ")}_.`
      : "";
  const evidence =
    opts.mcpStatus === "ok"
      ? opts.evidenceNarrative.trim()
      : "Evidence narrative unavailable for this run.";
  return `${opts.titleLine}

${decision}

## Evidence, retrieved via Tinybird MCP

${evidence}${footer}
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

/** Unstaged + untracked unified diff for per-flag substance checks. */
function listUnifiedDiff(): string {
  const tracked = runCaptured("git", ["diff", "--"]);
  const untracked = runCaptured("git", [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const parts = [tracked.log];
  for (const rel of untracked.log.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const show = runCaptured("git", ["diff", "--no-index", "/dev/null", rel]);
    // git diff --no-index exits 1 when files differ; log still holds the patch.
    parts.push(show.log);
  }
  return parts.join("\n");
}

async function recordDiffSubstanceFailure(
  payloads: Payload[],
  failingFlag: string,
  detail: string,
): Promise<void> {
  console.log(`gate=diff_substance status=fail flag=${failingFlag}`);
  await appendDecisions(
    payloads.map((p) => ({
      decided_at: new Date().toISOString(),
      run_id: p.run_id,
      flag_key: p.flag_key,
      verdict: "failed",
      route: p.route ?? "none",
      reason: `diff_substance gate failed for ${failingFlag}: ${detail}`,
      evidence: JSON.stringify({
        gate: "diff_substance",
        failing_flag: failingFlag,
        detail,
      }),
      pr_url: "",
      datafile_revision: p.datafile_revision ?? "",
    })),
  );
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


type PlanFile = {
  run_id: string;
  branch_name: string;
  candidates: Array<{
    flag_key: string;
    payload_b64: string;
    collapse_direction?: string;
    reason?: string;
  }>;
};

function loadPlan(): PlanFile | null {
  const argv = process.argv.filter((a) => a !== "--");
  const planArg = argv.find((a) => a.startsWith("--plan-s3="));
  const uri = planArg?.slice("--plan-s3=".length) || process.env.PLAN_S3_URI;
  if (!uri?.startsWith("s3://")) return null;
  const got = spawnSync("aws", ["s3", "cp", uri, "-"], {
    encoding: "utf8",
    cwd: root,
  });
  if (got.status !== 0) {
    throw new Error(`Failed to read plan ${uri}: ${got.stderr || got.stdout}`);
  }
  return JSON.parse(got.stdout) as PlanFile;
}

function writeSurgeonResult(body: unknown): void {
  const dest = process.env.RESULT_S3_URI;
  const json = `${JSON.stringify(body)}\n`;
  if (dest?.startsWith("s3://")) {
    const put = spawnSync("aws", ["s3", "cp", "-", dest], {
      input: json,
      encoding: "utf8",
      cwd: root,
    });
    if (put.status !== 0) {
      throw new Error(
        `Failed to write surgeon result to ${dest}: ${put.stderr || put.stdout}`,
      );
    }
    console.log(`Wrote surgeon result to ${dest}`);
  }
  console.log(`SURGEON_RESULT_JSON:${JSON.stringify(body)}`);
}

function extractMcpText(result: unknown): string {
  const r = result as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
  };
  if (typeof r.structuredContent === "object" && r.structuredContent) {
    return JSON.stringify(r.structuredContent);
  }
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");
  if (!text) throw new Error("Empty MCP call_endpoint response");
  const start = text.search(/[\{\[]/);
  if (start === -1) return text;
  const slice = text.slice(start);
  try {
    JSON.parse(slice);
    return slice;
  } catch {
    for (let end = slice.length; end > 1; end--) {
      try {
        JSON.parse(slice.slice(0, end));
        return slice.slice(0, end);
      } catch {
        /* continue */
      }
    }
  }
  return text;
}

/** Harness safety decisions use Tinybird REST only. Non-2xx is a hard failure. */
async function callTinybirdRest<T>(
  endpointName: string,
  params: Record<string, string | number> = {},
): Promise<T[]> {
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const token = process.env.TINYBIRD_TOKEN ?? "";
  if (!token) {
    throw new Error("TINYBIRD_TOKEN is required to re-verify flags before edit");
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const res = await fetch(
    `${host.replace(/\/$/, "")}/v0/pipes/${endpointName}.json?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tinybird pipe ${endpointName}: ${res.status} ${text}`);
  }
  const json = JSON.parse(text) as { data?: T[] };
  return json.data ?? [];
}

/**
 * Live re-check against flag_safety_check over REST before any edit.
 * Aborts if the plan/CLI payload is stale relative to Tinybird.
 * Returned row is authoritative evidence for the PR Decision section.
 */
async function reverifyFlagSafety(payload: Payload): Promise<SafetyCheckRow> {
  assertFlagKey(payload.flag_key);
  console.log(
    `Re-verifying ${payload.flag_key} via Tinybird REST flag_safety_check?key=…`,
  );
  let rows: SafetyCheckRow[];
  try {
    rows = await callTinybirdRest<SafetyCheckRow>("flag_safety_check", {
      key: payload.flag_key,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `flag_safety_check failed for ${payload.flag_key}: ${msg}`,
    );
  }
  const live = rows[0];
  if (!live) {
    throw new Error(
      `flag_safety_check returned no data for ${payload.flag_key}; aborting edit`,
    );
  }
  console.log(
    `tinybird_rest endpoint=flag_safety_check flag=${payload.flag_key} verdict=${live.verdict}`,
  );
  if (live.verdict !== "safe_to_remove") {
    throw new Error(
      `Live verdict for ${payload.flag_key} is ${live.verdict}, not safe_to_remove; aborting edit`,
    );
  }
  if (live.verdict !== payload.verdict) {
    throw new Error(
      `Live verdict for ${payload.flag_key} is ${live.verdict}, plan had ${payload.verdict}; aborting edit`,
    );
  }
  if (live.collapse_direction !== payload.collapse_direction) {
    throw new Error(
      `Live collapse_direction for ${payload.flag_key} is ${live.collapse_direction}, plan had ${payload.collapse_direction}; aborting edit`,
    );
  }
  const liveTarget = live.target_value ?? "";
  const planTarget = payload.target_value ?? "";
  if (liveTarget && planTarget && liveTarget !== planTarget) {
    throw new Error(
      `Live target_value for ${payload.flag_key} is ${liveTarget}, plan had ${planTarget}; aborting edit`,
    );
  }
  console.log(
    `Re-verify ok: ${payload.flag_key} verdict=${live.verdict} collapse=${live.collapse_direction}`,
  );
  return {
    flag_key: live.flag_key || payload.flag_key,
    verdict: live.verdict,
    route: live.route ?? payload.route,
    reason: live.reason ?? payload.reason,
    collapse_direction: live.collapse_direction,
    target_value: live.target_value ?? payload.target_value,
    evaluated_events: live.evaluated_events,
    blocked_events: live.blocked_events,
    evaluating_share:
      typeof live.evaluating_share === "number"
        ? live.evaluating_share
        : Number(live.evaluating_share ?? Number.NaN),
    datafile_revision: live.datafile_revision ?? payload.datafile_revision,
  };
}

type McpClient = {
  callTool: (args: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  close: () => Promise<void>;
};

async function connectTinybirdMcp(): Promise<McpClient> {
  const token = process.env.TINYBIRD_MCP_TOKEN ?? "";
  if (!token) {
    throw new Error("TINYBIRD_MCP_TOKEN is not set");
  }
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const { Client } = await import(
    "@modelcontextprotocol/sdk/client/index.js"
  );
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const url = new URL("https://mcp.tinybird.co");
  url.searchParams.set("token", token);
  url.searchParams.set("host", host);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({
    name: "stale-flags-surgeon-evidence",
    version: "0.1.0",
  });
  await client.connect(transport);
  return client;
}

function evidenceToolConfig(): ToolConfiguration {
  return {
    tools: [
      {
        toolSpec: {
          name: "tinybird_call_endpoint",
          description:
            "Call a Tinybird published endpoint for read-only evidence. Only flag_safety_check and cleanup_report are allowed.",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                endpoint_name: {
                  type: "string",
                  enum: [...MCP_ALLOWED_ENDPOINTS],
                  description: "Allowed Tinybird endpoint name",
                },
                params: {
                  type: "object",
                  description:
                    "Endpoint query params (e.g. key for flag_safety_check)",
                  additionalProperties: true,
                },
              },
              required: ["endpoint_name"],
            },
          },
        },
      },
    ],
  };
}

async function executeMcpEndpointCall(
  mcp: McpClient,
  endpointName: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (
    !(MCP_ALLOWED_ENDPOINTS as readonly string[]).includes(endpointName)
  ) {
    console.warn(
      `tinybird_mcp allowlist_reject endpoint=${endpointName}`,
    );
    return {
      ok: false,
      error: `endpoint_name "${endpointName}" is not allowlisted; allowed: ${MCP_ALLOWED_ENDPOINTS.join(", ")}`,
    };
  }
  try {
    const result = await mcp.callTool({
      name: "call_endpoint",
      arguments: {
        endpoint_name: endpointName,
        params,
        response_format: "JSON",
      },
    });
    const text = extractMcpText(result);
    console.log(
      `tinybird_mcp tool=call_endpoint endpoint=${endpointName} status=ok`,
    );
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `tinybird_mcp tool=call_endpoint endpoint=${endpointName} status=error`,
    );
    return { ok: false, error: msg };
  }
}

/**
 * After gates pass: separate Converse call with Tinybird MCP tools for PR
 * evidence narrative only. Decision section stays harness-owned.
 */
async function generateEvidenceNarrative(
  decisions: SafetyCheckRow[],
): Promise<{
  narrative: string;
  status: "ok" | "unavailable";
  toolCalls: number;
}> {
  const unavailable = (): {
    narrative: string;
    status: "ok" | "unavailable";
    toolCalls: number;
  } => ({
    narrative: "Evidence narrative unavailable for this run.",
    status: "unavailable",
    toolCalls: 0,
  });

  if (!process.env.TINYBIRD_MCP_TOKEN) {
    console.warn("TINYBIRD_MCP_TOKEN missing; evidence narrative unavailable");
    return unavailable();
  }
  if (process.env.BEDROCK_DISABLED === "1") {
    console.warn("BEDROCK_DISABLED=1; evidence narrative unavailable");
    return unavailable();
  }

  let mcp: McpClient | null = null;
  let toolCalls = 0;
  try {
    const region =
      process.env.AWS_REGION ?? process.env.AWS_REGION_NAME ?? "us-east-1";
    const client = new BedrockRuntimeClient({ region });
    mcp = await connectTinybirdMcp();

    const flagList = decisions.map((d) => d.flag_key).join(", ");
    const display = evidenceDisplayRows(decisions);
    const system = `You write a short evidence narrative for a flag-cleanup pull request.
The safety decision is already made by deterministic harness code and cannot be changed by you.
Use the tinybird_call_endpoint tool to fetch evidence per flag (flag_safety_check with params.key, and/or cleanup_report).
When mentioning session share or evaluating share, quote evaluating_share_pct from the harness-provided display values exactly (for example "96%"). Never recompute a percentage from a raw fraction, and never treat a raw fraction greater than 1 as a percentage.
Write plain sentences only. No speculation. Do not invent numbers. Do not recommend keeping or removing flags.
Do not output JSON, verdicts, collapse directions, or decision language. Evidence narrative only.`;

    const userText = `Write an evidence narrative for these flags already approved for removal: ${flagList}.

Harness-formatted display values (authoritative for any percentages you quote):
${JSON.stringify(display, null, 2)}

Call Tinybird for each flag's live evidence, then summarize what the endpoints returned in plain sentences. Quote evaluating_share_pct whenever you mention share.`;

    const messages: Message[] = [
      { role: "user", content: [{ text: userText }] },
    ];

    const deadline = Date.now() + MCP_EVIDENCE_TIMEOUT_MS;
    let finalText = "";

    while (Date.now() < deadline) {
      const res = await client.send(
        new ConverseCommand({
          modelId: bedrockModelId(),
          system: [{ text: system }],
          messages,
          inferenceConfig: { maxTokens: 2048, temperature: 0 },
          toolConfig: evidenceToolConfig(),
        }),
      );

      const assistantMsg = res.output?.message;
      if (!assistantMsg?.content) {
        throw new Error("Empty Converse response for evidence narrative");
      }
      messages.push({
        role: "assistant",
        content: assistantMsg.content,
      });

      if (res.stopReason !== "tool_use") {
        finalText = (assistantMsg.content ?? [])
          .map((c) => ("text" in c && c.text ? c.text : ""))
          .join("\n")
          .trim();
        break;
      }

      const toolUses = (assistantMsg.content ?? []).filter(
        (c): c is ContentBlock.ToolUseMember =>
          "toolUse" in c && Boolean(c.toolUse),
      );
      if (toolUses.length === 0) {
        throw new Error("stopReason=tool_use but no toolUse blocks");
      }

      const toolResultBlocks: ContentBlock[] = [];
      for (const block of toolUses) {
        toolCalls += 1;
        if (toolCalls > MAX_MCP_TOOL_CALLS) {
          console.warn(
            `MCP evidence tool call cap (${MAX_MCP_TOOL_CALLS}) exceeded`,
          );
          throw new Error("MCP evidence tool call cap exceeded");
        }
        const tu = block.toolUse!;
        const input = (tu.input ?? {}) as {
          endpoint_name?: string;
          params?: Record<string, unknown>;
        };
        const endpointName = String(input.endpoint_name ?? "");
        const params = input.params ?? {};
        const executed = await executeMcpEndpointCall(
          mcp,
          endpointName,
          params,
        );
        toolResultBlocks.push({
          toolResult: {
            toolUseId: tu.toolUseId!,
            content: executed.ok
              ? [{ text: executed.text }]
              : [{ text: JSON.stringify({ error: executed.error }) }],
            status: executed.ok ? "success" : "error",
          },
        });
      }
      messages.push({ role: "user", content: toolResultBlocks });
    }

    if (!finalText) {
      throw new Error("Evidence narrative timed out or returned empty text");
    }

    console.log(`mcp_evidence=ok tool_calls=${toolCalls}`);
    return { narrative: finalText, status: "ok", toolCalls };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Evidence narrative failed: ${msg}`);
    console.log(`mcp_evidence=unavailable tool_calls=${toolCalls}`);
    return { ...unavailable(), toolCalls };
  } finally {
    await mcp?.close().catch(() => undefined);
  }
}

async function applyFlagLocally(
  payload: Payload,
): Promise<{ decision: SafetyCheckRow }> {
  assertFlagKey(payload.flag_key);
  if (payload.collapse_direction === "none") {
    throw new Error(`Refusing collapse_direction=none for ${payload.flag_key}`);
  }
  const decision = await reverifyFlagSafety(payload);
  deleteYaml(payload.flag_key);
  const files = findReferenceFiles(payload.flag_key);
  if (files.length === 0) {
    console.log(`No app call sites for ${payload.flag_key}; YAML-only removal`);
  }
  const { ok, gateLog } = await editLoop(payload, files);
  if (!ok) {
    throw new Error(
      `gates failed for ${payload.flag_key}: ${gateLog.slice(0, 4000)}`,
    );
  }
  return { decision };
}

async function runPlanMode(plan: PlanFile): Promise<void> {
  if (!plan.candidates?.length) {
    writeSurgeonResult({
      ok: true,
      pr_url: "",
      run_id: plan.run_id,
      flags: [],
      note: "empty plan",
    });
    return;
  }

  const demoBranch = process.env.DEMO_BRANCH ?? "demo";
  const workBranch = plan.branch_name || `agent/cleanup-${plan.run_id}`;
  const payloads: Payload[] = plan.candidates.map((c) => {
    const p = JSON.parse(
      Buffer.from(c.payload_b64, "base64url").toString("utf8"),
    ) as Payload;
    assertFlagKey(p.flag_key);
    return p;
  });

  console.log(
    `Surgeon plan mode run=${plan.run_id} branch=${workBranch} flags=${payloads.map((p) => p.flag_key).join(",")}`,
  );

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

  const rewind = (): void => {
    run("git", ["reset", "--hard", `origin/${demoBranch}`]);
    run("git", ["clean", "-fd"]);
    run("git", ["checkout", demoBranch]);
  };

  try {
    const decisions: SafetyCheckRow[] = [];
    for (const payload of payloads) {
      console.log(
        `\n=== Applying ${payload.flag_key} (${payload.collapse_direction}) ===`,
      );
      const { decision } = await applyFlagLocally(payload);
      decisions.push(decision);
    }

    const dirty = listDirtyPaths().filter(
      (p) =>
        p.startsWith("apps/") ||
        p.startsWith("featurevisor/features/") ||
        p.startsWith("featurevisor/tests/") ||
        p.startsWith("featurevisor/.featurevisor/"),
    );
    if (dirty.length === 0) {
      rewind();
      throw new Error(
        "No staged changes after successful gates (all-or-nothing abort)",
      );
    }

    const substance = checkDiffSubstance(
      payloads.map((p) => p.flag_key),
      dirty,
      listUnifiedDiff(),
    );
    if (!substance.ok) {
      await recordDiffSubstanceFailure(
        payloads,
        substance.flag,
        substance.detail,
      );
      rewind();
      throw new Error(
        `diff_substance gate failed for ${substance.flag}: ${substance.detail}`,
      );
    }

    run("git", [
      "config",
      "user.email",
      "stale-flags-agent@users.noreply.github.com",
    ]);
    run("git", ["config", "user.name", "stale-flags-agent"]);
    run("git", ["add", ...dirty]);
    const commit = runCaptured("git", [
      "commit",
      "-m",
      `remove flags: ${payloads.map((p) => p.flag_key).join(", ")}`,
    ]);
    if (!commit.ok) {
      rewind();
      throw new Error(`git commit failed: ${commit.log.slice(0, 1000)}`);
    }

    if (!run("git", ["push", "-u", "origin", workBranch, "--force-with-lease"])) {
      if (!run("git", ["push", "-u", "origin", workBranch, "--force"])) {
        rewind();
        throw new Error("git push failed");
      }
    }

    const evidence = await generateEvidenceNarrative(decisions);
    const body = buildPrBody({
      runIdValue: plan.run_id,
      titleLine: `## Flag cleanup batch

**Branch:** \`${plan.branch_name}\`

Removed ${payloads.length} independently \`safe_to_remove\` flag(s) in one all-or-nothing PR.`,
      decisions,
      evidenceNarrative: evidence.narrative,
      mcpStatus: evidence.status,
      gatesLine: GATES_LINE,
    });
    mkdirSync(path.join(root, ".local-data"), { recursive: true });
    writeFileSync(path.join(root, `.local-data/pr-${plan.run_id}.md`), body);

    let prUrl = "";
    if (process.env.GITHUB_TOKEN) {
      prUrl = await ensurePr({
        repo: process.env.GITHUB_REPO ?? "lucamezzalira/stale-flag-cleanup",
        demoBranch,
        workBranch,
        title: `Remove feature flags: ${payloads.map((p) => p.flag_key).join(", ")}`,
        body,
      });
    } else {
      prUrl = `file://.local-data/pr-${plan.run_id}.md`;
    }

    for (const payload of payloads) {
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
    }

    run("git", ["checkout", demoBranch]);
    writeSurgeonResult({
      ok: true,
      pr_url: prUrl,
      run_id: plan.run_id,
      branch_name: workBranch,
      flags: payloads.map((p) => p.flag_key),
    });
    console.log(prUrl);
  } catch (err) {
    rewind();
    const message = err instanceof Error ? err.message : String(err);
    writeSurgeonResult({
      ok: false,
      pr_url: "",
      run_id: plan.run_id,
      branch_name: workBranch,
      flags: payloads.map((p) => p.flag_key),
      error: message.slice(0, 2000),
    });
    throw err;
  }
}

async function runSingleFlagMode(): Promise<void> {
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
    const decision = await reverifyFlagSafety(payload);
    const files = findReferenceFiles(payload.flag_key);
    console.log("Would remove YAML + edit:");
    console.log(`  featurevisor/features/${payload.flag_key}.yml`);
    console.log(`  featurevisor/tests/features/${payload.flag_key}.spec.yml`);
    for (const f of files) console.log(`  ${path.relative(root, f)}`);
    console.log("\n--- PR body preview (decision only; MCP evidence skipped in dry-run) ---\n");
    console.log(
      buildPrBody({
        runIdValue: payload.run_id,
        titleLine: `## Flag cleanup: \`${payload.flag_key}\``,
        decisions: [decision],
        evidenceNarrative: "",
        mcpStatus: "unavailable",
      }),
    );
    return;
  }

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

  const rewind = (): void => {
    run("git", ["reset", "--hard", `origin/${demoBranch}`]);
    run("git", ["clean", "-fd"]);
    run("git", ["checkout", demoBranch]);
  };

  try {
    const { decision } = await applyFlagLocally(payload);
    const evidence = await generateEvidenceNarrative([decision]);
    const body = buildPrBody({
      runIdValue: payload.run_id,
      titleLine: `## Flag cleanup: \`${payload.flag_key}\``,
      decisions: [decision],
      evidenceNarrative: evidence.narrative,
      mcpStatus: evidence.status,
    });
    mkdirSync(path.join(root, ".local-data"), { recursive: true });
    writeFileSync(
      path.join(root, `.local-data/pr-${payload.flag_key}.md`),
      body,
    );

    const dirty = listDirtyPaths().filter(
      (p) =>
        p.startsWith("apps/") ||
        p.startsWith("featurevisor/features/") ||
        p.startsWith("featurevisor/tests/") ||
        p.startsWith("featurevisor/.featurevisor/"),
    );
    if (dirty.length === 0) {
      rewind();
      throw new Error("No staged changes after successful gates");
    }
    const substance = checkDiffSubstance(
      [payload.flag_key],
      dirty,
      listUnifiedDiff(),
    );
    if (!substance.ok) {
      await recordDiffSubstanceFailure(
        [payload],
        substance.flag,
        substance.detail,
      );
      rewind();
      throw new Error(
        `diff_substance gate failed for ${substance.flag}: ${substance.detail}`,
      );
    }
    run("git", [
      "config",
      "user.email",
      "stale-flags-agent@users.noreply.github.com",
    ]);
    run("git", ["config", "user.name", "stale-flags-agent"]);
    run("git", ["add", ...dirty]);
    const commit = runCaptured("git", [
      "commit",
      "-m",
      `remove flag ${payload.flag_key} (${payload.collapse_direction})`,
    ]);
    if (!commit.ok) {
      rewind();
      throw new Error(`git commit failed: ${commit.log.slice(0, 1000)}`);
    }
    let prUrl = `file://.local-data/pr-${payload.flag_key}.md`;
    if (process.env.GITHUB_TOKEN) {
      if (!run("git", ["push", "-u", "origin", workBranch, "--force"])) {
        rewind();
        throw new Error("git push failed");
      }
      prUrl = await ensurePr({
        repo: process.env.GITHUB_REPO ?? "lucamezzalira/stale-flag-cleanup",
        demoBranch,
        workBranch,
        title: `Remove feature flag ${payload.flag_key}`,
        body,
      });
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
    run("git", ["checkout", demoBranch]);
    console.log(prUrl);
  } catch (err) {
    rewind();
    throw err;
  }
}

async function main(): Promise<void> {
  await loadDotEnvOnce();
  const plan = loadPlan();
  if (plan) {
    await runPlanMode(plan);
    return;
  }
  await runSingleFlagMode();
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
