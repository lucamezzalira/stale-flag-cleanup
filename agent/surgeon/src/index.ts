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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

type Payload = {
  flag_key: string;
  verdict: string;
  reason: string;
  target_value: string;
  collapse_direction: "keep_gated_branch" | "delete_gated_branch" | "none";
  evidence: Record<string, unknown>;
  run_id: string;
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

async function ollamaPrBody(payload: Payload, diffStat: string): Promise<string> {
  if (process.env.OLLAMA_DISABLED === "1") {
    return fallbackBody(payload);
  }
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const model = process.env.OLLAMA_MODEL ?? "qwen3:8b";
  const prompt = `Write a short GitHub PR body (markdown) for removing feature flag ${payload.flag_key}.
Verdict: ${payload.verdict}
Reason: ${payload.reason}
Collapse: ${payload.collapse_direction}
Target: ${payload.target_value}
Run id: ${payload.run_id}
Diff stats: ${diffStat}
Keep it factual, no hype.`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${host.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { response?: string };
    return json.response ?? fallbackBody(payload);
  } catch {
    return fallbackBody(payload);
  }
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

function applyEdits(payload: Payload): string[] {
  const changed: string[] = [];
  const feature = path.join(
    root,
    "featurevisor/features",
    `${payload.flag_key}.yml`,
  );
  const test = path.join(
    root,
    "featurevisor/tests/features",
    `${payload.flag_key}.spec.yml`,
  );
  if (existsSync(feature)) {
    unlinkSync(feature);
    changed.push(feature);
  }
  if (existsSync(test)) {
    unlinkSync(test);
    changed.push(test);
  }

  if (payload.flag_key === "promo_banner_2025") {
    // delete_gated_branch: promo was at 0% / target false → drop banner + callout
    const listing = path.join(root, "apps/web/src/pages/Listing.tsx");
    writeFileSync(
      listing,
      `const PRODUCTS = [
  { name: "Classic Tee", price: "$28", code: "TEE-01" },
  { name: "Canvas Tote", price: "$42", code: "TOT-02" },
  { name: "Wool Cap", price: "$36", code: "CAP-03" },
  { name: "Field Jacket", price: "$168", code: "JKT-04" },
  { name: "Trail Bottle", price: "$24", code: "BTL-05" },
  { name: "Desk Lamp", price: "$88", code: "LMP-06" },
];

export function ListingPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Catalog surface used to exercise abandoned promo traffic.</p>
        </div>
      </div>

      <div className="grid" style={{ marginTop: "1rem" }}>
        {PRODUCTS.map((p) => (
          <article className="product" key={p.code}>
            <div className="product-visual">{p.code}</div>
            <div className="product-body">
              <h2>{p.name}</h2>
              <div className="price">{p.price}</div>
              <button type="button" className="btn secondary">
                Add to cart
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
`,
    );
    changed.push(listing);
  }

  if (payload.flag_key === "one_click_buy") {
    // keep_gated_branch: target true → keep one-click CTA, drop flag plumbing
    const checkout = path.join(root, "apps/web/src/pages/Checkout.tsx");
    let src = readFileSync(checkout, "utf8");
    src = src.replace(/\s*const oneClick = useFlag\("one_click_buy"\);\n/, "\n");
    src = src.replace(
      /\s*\{oneClick\.enabled \? \(\s*<button type="button" className="btn">\s*One-click buy\s*<\/button>\s*\) : \(\s*<button type="button" className="btn secondary">\s*Continue to payment\s*<\/button>\s*\)\}\s*/,
      `
              <button type="button" className="btn">
                One-click buy
              </button>
`,
    );
    src = src.replace(
      /\s*<FlagCallout\s*\n\s*flagKey="one_click_buy"\s*\n\s*enabled=\{oneClick\.enabled\}\s*\n\s*variation=\{oneClick\.variation\}\s*\n\s*outcome=\{oneClick\.outcome\}\s*\n\s*blockedBy=\{oneClick\.blockedBy\}\s*\n\s*\/>\s*/,
      "\n",
    );
    writeFileSync(checkout, src);
    changed.push(checkout);
  }

  // Rebuild datafiles so generated JSON no longer contains the flag
  spawnSync("pnpm", ["--filter", "@stale-flags/featurevisor", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return changed;
}

function flagStillReferenced(flagKey: string): string {
  const grep = spawnSync(
    "rg",
    [
      "-n",
      flagKey,
      "apps",
      "packages",
      "featurevisor/features",
      "featurevisor/tests",
      "featurevisor/attributes",
      "featurevisor/targets",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return (grep.stdout || "").trim();
}

function securityCheck(changed: string[]): { ok: boolean; detail: string } {
  const allowed = ["apps/", "packages/", "featurevisor/"];
  const denied = ["tinybird/", "agent/", "infra/", "tools/"];
  for (const f of changed) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    if (denied.some((d) => rel.startsWith(d))) {
      return { ok: false, detail: `denied path ${rel}` };
    }
    if (!allowed.some((a) => rel.startsWith(a))) {
      return { ok: false, detail: `path not allowlisted ${rel}` };
    }
  }
  return { ok: true, detail: "allowlist ok" };
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return r.status === 0;
}

async function main(): Promise<void> {
  const argv = process.argv.filter((a) => a !== "--");
  const dryRun = argv.includes("--dry-run");
  const payload = parsePayload();
  if (payload.collapse_direction === "none") {
    throw new Error("Refusing collapse_direction=none");
  }

  console.log(
    `Surgeon ${payload.flag_key} collapse=${payload.collapse_direction} dryRun=${dryRun}`,
  );

  if (dryRun) {
    console.log("Would remove:");
    console.log(`  featurevisor/features/${payload.flag_key}.yml`);
    console.log(`  featurevisor/tests/features/${payload.flag_key}.spec.yml`);
    console.log(`  collapse call sites in apps/web (${payload.collapse_direction})`);
    console.log("\n--- PR body preview ---\n");
    console.log(await ollamaPrBody(payload, "dry-run"));
    return;
  }

  const demoBranch = process.env.DEMO_BRANCH ?? "demo";
  const workBranch = `agent/remove-${payload.flag_key}`;
  const restore = (): void => {
    run("git", ["reset", "--hard", "HEAD"]);
    run("git", ["checkout", "main"]);
    run("git", ["clean", "-fd", "featurevisor/datafiles"]);
  };

  // Fresh branch from demo so each PR is isolated
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

  const changed = applyEdits(payload);
  const leftover = flagStillReferenced(payload.flag_key);
  if (leftover) {
    console.error("Flag key still referenced:\n", leftover);
    await appendDecisions([
      {
        decided_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        run_id: payload.run_id,
        flag_key: payload.flag_key,
        verdict: "failed",
        reason: "flag key still present after edit",
        evidence: JSON.stringify({ grep: leftover }),
        pr_url: "",
      },
    ]);
    restore();
    process.exit(1);
  }

  const sec = securityCheck(changed);
  const validationOk =
    run("pnpm", ["--filter", "@stale-flags/web", "typecheck"]) &&
    run("pnpm", ["--filter", "@stale-flags/web", "build"]) &&
    run("pnpm", ["--filter", "@stale-flags/featurevisor", "lint"]) &&
    run("pnpm", ["--filter", "@stale-flags/featurevisor", "test"]);

  if (!validationOk || !sec.ok) {
    await appendDecisions([
      {
        decided_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        run_id: payload.run_id,
        flag_key: payload.flag_key,
        verdict: "failed",
        reason: `validation/security gates failed: ${sec.detail}`,
        evidence: JSON.stringify(payload.evidence),
        pr_url: "",
      },
    ]);
    restore();
    process.exit(1);
  }

  const body = await ollamaPrBody(payload, changed.join(", "));
  mkdirSync(path.join(root, ".local-data"), { recursive: true });
  const localPr = path.join(root, `.local-data/pr-${payload.flag_key}.md`);
  writeFileSync(localPr, body);

  let prUrl = `file://.local-data/pr-${payload.flag_key}.md`;
  if (process.env.GITHUB_TOKEN) {
    run("git", ["add", "apps", "featurevisor"]);
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
    const prEnv = {
      ...process.env,
      GH_TOKEN: process.env.GITHUB_TOKEN,
    };
    const pr = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        process.env.GITHUB_REPO ?? "lucamezzalira/stale-flag-cleanup",
        "--base",
        demoBranch,
        "--head",
        workBranch,
        "--title",
        `Remove feature flag ${payload.flag_key}`,
        "--body",
        body,
      ],
      { cwd: root, encoding: "utf8", env: prEnv },
    );
    if (pr.status !== 0) {
      console.error(pr.stderr || pr.stdout);
      restore();
      throw new Error("gh pr create failed");
    }
    prUrl = (pr.stdout || "").trim() || prUrl;
    run("git", ["checkout", "main"]);
  } else {
    console.log(`No GITHUB_TOKEN — wrote ${localPr}`);
  }

  await appendDecisions([
    {
      decided_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      run_id: payload.run_id,
      flag_key: payload.flag_key,
      verdict: "safe_to_remove",
      reason: payload.reason,
      evidence: JSON.stringify(payload.evidence),
      pr_url: prUrl,
    },
  ]);
  console.log(prUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
