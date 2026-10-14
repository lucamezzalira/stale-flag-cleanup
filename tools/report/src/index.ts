import { loadStore } from "@stale-flags/local-store";
import { cleanupReport, runSafetyCheck } from "@stale-flags/verdicts";

const colors: Record<string, string> = {
  safe_to_remove: "\x1b[32m",
  blocked: "\x1b[31m",
  inconclusive: "\x1b[33m",
  failed: "\x1b[35m",
};
const reset = "\x1b[0m";

function color(verdict: string, text: string): string {
  return `${colors[verdict] ?? ""}${text}${reset}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--flag");
  const history = args.includes("--history");
  const store = await loadStore();

  if (history) {
    console.log("cleanup_decision_log (UTC)\n");
    for (const row of store.decisions.slice(-50)) {
      console.log(
        `${row.decided_at}  ${row.run_id}  ${row.flag_key}  ${color(row.verdict, row.verdict)}  ${row.pr_url || "-"}`,
      );
      console.log(`  ${row.reason}`);
    }
    if (store.decisions.length === 0) {
      console.log("(empty — only real agent runs write this log)");
    }
    return;
  }

  if (flagIdx >= 0) {
    const flag = args[flagIdx + 1];
    if (!flag) throw new Error("--flag requires a key");
    const result = runSafetyCheck(store, { flag_key: flag });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const rows = cleanupReport(store);
  console.log(
    "flag_key                 route       verdict           collapse             reason",
  );
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(
      `${r.flag_key.padEnd(24)} ${r.route.padEnd(11)} ${color(r.verdict, r.verdict.padEnd(17))} ${r.collapse_direction.padEnd(20)} ${r.reason.slice(0, 60)}…`,
    );
  }
  console.log(`\n${rows.length} flags · timestamps UTC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
