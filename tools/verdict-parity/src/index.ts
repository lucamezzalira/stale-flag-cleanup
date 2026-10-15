/**
 * Parity check: Tinybird flag_safety_check + cleanup_report vs packages/verdicts.
 * Authoritative copy is the pipe; TypeScript mirrors it for local/offline use.
 */
import { loadDotEnvOnce, loadStore } from "@stale-flags/local-store";
import {
  cleanupReport,
  runSafetyCheck,
  type SafetyCheckResult,
} from "@stale-flags/verdicts";

type PipeRow = {
  flag_key: string;
  verdict: string;
  route: string;
  reason: string;
  collapse_direction: string;
};

async function callPipe(
  host: string,
  token: string,
  name: string,
  params: Record<string, string> = {},
): Promise<PipeRow[]> {
  const qs = new URLSearchParams(params);
  const res = await fetch(
    `${host.replace(/\/$/, "")}/v0/pipes/${name}.json?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${name}: ${res.status} ${text}`);
  }
  const json = JSON.parse(text) as { data: PipeRow[] };
  return json.data ?? [];
}

function fields(r: {
  verdict: string;
  route: string;
  reason: string;
  collapse_direction: string;
}) {
  return {
    verdict: r.verdict,
    route: r.route,
    reason: r.reason,
    collapse_direction: r.collapse_direction,
  };
}

function diff(
  label: string,
  a: ReturnType<typeof fields>,
  b: ReturnType<typeof fields>,
): string[] {
  const out: string[] = [];
  for (const k of Object.keys(a) as (keyof typeof a)[]) {
    if (a[k] !== b[k]) {
      out.push(`${label}.${k}: pipe/ts mismatch\n  a=${a[k]}\n  b=${b[k]}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  await loadDotEnvOnce();
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const token = process.env.TINYBIRD_TOKEN ?? "";
  if (!token) {
    throw new Error("TINYBIRD_TOKEN required for parity check");
  }

  const store = await loadStore();
  const keys = [
    ...new Set(store.definitions.map((d) => d.flag_key)),
  ].sort();
  if (keys.length === 0) {
    throw new Error(
      "No local definitions; run `pnpm seed` (or ensure .local-data exists)",
    );
  }

  const reportPipe = await callPipe(host, token, "cleanup_report");
  const reportByKey = new Map(reportPipe.map((r) => [r.flag_key, r]));
  const tsReport = cleanupReport(store);
  const tsByKey = new Map(tsReport.map((r) => [r.flag_key, r]));

  const mismatches: string[] = [];

  for (const key of keys) {
    const safetyRows = await callPipe(host, token, "flag_safety_check", {
      key,
    });
    const safety = safetyRows[0];
    if (!safety) {
      mismatches.push(`${key}: flag_safety_check returned no row`);
      continue;
    }
    const ts = runSafetyCheck(store, { flag_key: key }) as SafetyCheckResult;
    mismatches.push(
      ...diff(`${key}/safety`, fields(safety), fields(ts)).map(
        (m) => m.replace("pipe/ts", "safety_pipe vs runSafetyCheck"),
      ),
    );

    const report = reportByKey.get(key);
    const tsR = tsByKey.get(key);
    if (!report) {
      mismatches.push(`${key}: missing from cleanup_report pipe`);
      continue;
    }
    if (!tsR) {
      mismatches.push(`${key}: missing from TS cleanupReport`);
      continue;
    }
    mismatches.push(
      ...diff(`${key}/report`, fields(report), fields(tsR)).map((m) =>
        m.replace("pipe/ts", "cleanup_report vs cleanupReport"),
      ),
    );

    // safety pipe and cleanup_report should agree on the cascade fields
    mismatches.push(
      ...diff(`${key}/pipe-pair`, fields(safety), fields(report)).map((m) =>
        m.replace("pipe/ts", "flag_safety_check vs cleanup_report"),
      ),
    );
  }

  if (mismatches.length) {
    console.error("Verdict parity FAILED:\n" + mismatches.join("\n"));
    process.exit(1);
  }
  console.log(
    `Verdict parity OK for ${keys.length} flags (pipes + packages/verdicts).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
