import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const demoBranch = process.env.DEMO_BRANCH ?? "demo";
const tag = process.env.DEMO_RESET_TAG ?? "demo-clean";

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (r.status !== 0) {
    console.warn(`${cmd} ${args.join(" ")} exited ${r.status}`);
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

  run("git", ["fetch", "origin", tag]);
  run("git", ["checkout", demoBranch]);
  run("git", ["reset", "--hard", tag]);

  run("pnpm", ["datafile:publish"]);
  run("pnpm", ["publish-defs"]);
  run("pnpm", ["seed"]);

  console.log("Demo reset complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
