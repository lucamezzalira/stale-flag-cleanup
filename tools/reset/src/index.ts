import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEMO_TINYBIRD_TABLES,
  truncateTinybirdDatasources,
} from "@stale-flags/local-store";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const demoBranch = process.env.DEMO_BRANCH ?? "demo";
const tag = process.env.DEMO_RESET_TAG ?? "demo-clean";

function run(cmd: string, args: string[], opts?: { fatal?: boolean }): void {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (r.status !== 0) {
    const msg = `${cmd} ${args.join(" ")} exited ${r.status}`;
    if (opts?.fatal !== false && (cmd === "git" || cmd === "pnpm")) {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

async function main(): Promise<void> {
  console.log("Resetting demo branch state (never touches main)…");

  if (process.env.GITHUB_TOKEN) {
    const list = spawnSync(
      "gh",
      ["pr", "list", "--base", demoBranch, "--json", "number,headRefName,title"],
      { cwd: root, encoding: "utf8", env: process.env },
    );
    try {
      const prs = JSON.parse(list.stdout || "[]") as Array<{
        number: number;
        headRefName: string;
        title: string;
      }>;
      for (const pr of prs) {
        if (!pr.headRefName.startsWith("agent/")) continue;
        run("gh", [
          "pr",
          "comment",
          String(pr.number),
          "--body",
          "Demo was reset; closing this agent PR.",
        ]);
        run("gh", ["pr", "close", String(pr.number)]);
        run("git", ["push", "origin", "--delete", pr.headRefName]);
      }
    } catch {
      console.warn("Could not list/close PRs");
    }
  }

  run("git", ["fetch", "origin", tag], { fatal: true });
  run("git", ["checkout", demoBranch], { fatal: true });
  run("git", ["reset", "--hard", tag], { fatal: true });

  // Clear Tinybird Cloud before reseed so last_pr_url / stacked activity cannot poison the next run.
  // seed itself also truncates; this makes reset safe even if seed is skipped.
  await truncateTinybirdDatasources([...DEMO_TINYBIRD_TABLES]);

  run("pnpm", ["datafile:publish"], { fatal: true });
  // seed writes flag_definitions (with backdated captured_at). Do not also run
  // publish-defs here: that would set captured_at=now() and confuse age filters.
  run("pnpm", ["seed"], { fatal: true });

  console.log("Demo reset complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
