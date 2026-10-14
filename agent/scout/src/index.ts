import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecisions, loadStore } from "@stale-flags/local-store";
import {
  cleanupReport,
  listCandidates,
  type SafetyCheckResult,
} from "@stale-flags/verdicts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

function runId(): string {
  return `run_${new Date().toISOString().replace(/[-:Z.]/g, "").slice(0, 15)}`;
}

async function main(): Promise<void> {
  const argv = process.argv.filter((a) => a !== "--");
  const dryRun = argv.includes("--dry-run") || !argv.includes("--full");
  const full = argv.includes("--full");
  const store = await loadStore();
  const candidates = listCandidates(store);
  const openPr = new Set(
    store.decisions
      .filter((d) => d.pr_url && d.verdict === "safe_to_remove")
      .map((d) => d.flag_key),
  );

  const id = runId();
  console.log(`Scout run_id=${id} dryRun=${dryRun || !full}\n`);

  const results: SafetyCheckResult[] = [];
  for (const c of candidates) {
    if (openPr.has(c.flag_key)) {
      console.log(`skip ${c.flag_key} (open PR already logged)`);
      continue;
    }
    const report = cleanupReport(store).find((r) => r.flag_key === c.flag_key);
    if (!report) continue;
    results.push(report);
    console.log(
      `${c.flag_key.padEnd(24)} route=${report.route.padEnd(10)} ${report.verdict.padEnd(16)} ${report.collapse_direction}`,
    );
    console.log(`  ${report.reason}`);
  }

  const decisions = results.map((r) => ({
    decided_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    run_id: id,
    flag_key: r.flag_key,
    verdict: r.verdict,
    reason: r.reason,
    evidence: JSON.stringify(r.evidence),
    pr_url: "",
  }));

  if (!dryRun && (full || !process.argv.includes("--dry-run"))) {
    // default without flags: dry-ish print only unless --full
  }

  if (dryRun || !full) {
    console.log(
      `\nProposed surgeon actions: ${results.filter((r) => r.verdict === "safe_to_remove" && r.collapse_direction !== "none").map((r) => r.flag_key).join(", ") || "(none)"}`,
    );
    console.log("Re-run with --full to write cleanup_decision_log and dispatch surgeons.");
    return;
  }

  await appendDecisions(decisions);

  for (const r of results) {
    if (r.verdict !== "safe_to_remove" || r.collapse_direction === "none") {
      continue;
    }
    const payload = Buffer.from(JSON.stringify({ ...r, run_id: id })).toString(
      "base64url",
    );
    console.log(`\nDispatching surgeon for ${r.flag_key}…`);
    const proc = spawnSync(
      "pnpm",
      ["--filter", "@stale-flags/surgeon", "start", "--", `--payload=${payload}`],
      { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (proc.status !== 0) {
      console.error(`Surgeon failed for ${r.flag_key}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
