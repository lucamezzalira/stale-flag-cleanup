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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for Events API → MV to match local TS verdicts (handles ingest lag). */
async function waitForPipeSettle(
  host: string,
  token: string,
  keys: string[],
  tsByKey: Map<string, SafetyCheckResult>,
): Promise<void> {
  const maxAttempts = 24;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const reportPipe = await callPipe(host, token, "cleanup_report");
    const reportByKey = new Map(reportPipe.map((r) => [r.flag_key, r]));
    let ok = true;
    for (const key of keys) {
      const pipe = reportByKey.get(key);
      const ts = tsByKey.get(key);
      if (!pipe || !ts) {
        ok = false;
        break;
      }
      if (
        pipe.verdict !== ts.verdict ||
        pipe.route !== ts.route ||
        pipe.collapse_direction !== ts.collapse_direction ||
        pipe.reason !== ts.reason
      ) {
        ok = false;
        break;
      }
    }
    if (ok) {
      console.log(`Tinybird settled after ${attempt} attempt(s)`);
      return;
    }
    console.log(
      `Waiting for Tinybird MV settle (${attempt}/${maxAttempts})…`,
    );
    await sleep(5000);
  }
  throw new Error(
    "Tinybird cleanup_report did not match local verdicts within settle window (concurrent seed or MV lag)",
  );
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

  const tsReport = cleanupReport(store);
  const tsByKey = new Map(tsReport.map((r) => [r.flag_key, r]));

  await waitForPipeSettle(host, token, keys, tsByKey);

  const reportPipe = await callPipe(host, token, "cleanup_report");
  const reportByKey = new Map(reportPipe.map((r) => [r.flag_key, r]));

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
      ...diff(`${key}/safety`, fields(safety), fields(ts)).map((m) =>
        m.replace("pipe/ts", "safety_pipe vs runSafetyCheck"),
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
