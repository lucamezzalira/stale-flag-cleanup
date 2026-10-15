import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDecisions, loadStore } from "@stale-flags/local-store";
import {
  cleanupReport,
  listCandidates,
  type CollapseDirection,
  type Route,
  type SafetyCheckResult,
  type Verdict,
} from "@stale-flags/verdicts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

function runId(): string {
  return `run_${new Date().toISOString().replace(/[-:Z.]/g, "").slice(0, 15)}`;
}

type CandidateRow = {
  flag_key: string;
  route?: string;
  last_verdict?: string | null;
  last_pr_url?: string | null;
  last_datafile_revision?: string | null;
  datafile_revision?: string | null;
};

type PipeRow = {
  flag_key: string;
  verdict: string;
  route: string;
  reason: string;
  target_value: string;
  collapse_direction: string;
  datafile_revision?: string;
  evaluated_events?: number;
  blocked_events?: number;
  descendant_count?: number;
  evaluating_share?: number;
  rollout_percentage?: number;
  parent_key?: string;
};

function useTinybird(): boolean {
  return Boolean(
    process.env.TINYBIRD_TOKEN &&
      (process.env.SCOUT_SOURCE === "tinybird" ||
        process.env.SCOUT_SOURCE === "mcp" ||
        process.env.AWS_EXECUTION_ENV ||
        process.env.CODEBUILD_BUILD_ID),
  );
}

async function callTinybirdEndpoint<T>(
  endpointName: string,
  params: Record<string, string | number> = {},
): Promise<T[]> {
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const token = process.env.TINYBIRD_TOKEN ?? "";
  if (!token) throw new Error("TINYBIRD_TOKEN is required for Tinybird mode");

  // REST-first (deterministic scout in Fargate). Optional MCP if SCOUT_MCP=1.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  try {
    const res = await fetch(
      `${host.replace(/\/$/, "")}/v0/pipes/${endpointName}.json?${qs}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Tinybird pipe ${endpointName}: ${res.status} ${text}`);
    }
    const json = JSON.parse(text) as { data: T[] };
    return json.data ?? [];
  } catch (restErr) {
    if (process.env.SCOUT_MCP !== "1") throw restErr;
    console.warn(
      `Tinybird REST failed (${restErr instanceof Error ? restErr.message : restErr}); trying MCP`,
    );
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const url = new URL("https://mcp.tinybird.co");
  url.searchParams.set("token", token);
  url.searchParams.set("host", host);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "stale-flags-scout", version: "0.1.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "call_endpoint",
      arguments: {
        endpoint_name: endpointName,
        params,
        response_format: "JSON",
      },
    });
    const text = extractMcpText(result);
    const parsed = JSON.parse(text) as { data?: T[] } | T[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.data ?? [];
  } finally {
    await client.close().catch(() => undefined);
  }
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
  // MCP sometimes wraps or appends prose; pull the first JSON object/array.
  const start = text.search(/[\{\[]/);
  if (start === -1) return text;
  const slice = text.slice(start);
  try {
    JSON.parse(slice);
    return slice;
  } catch {
    // Walk braces to find a parseable prefix
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

function shouldSkip(
  c: CandidateRow,
  failedOrOpen: Map<string, { verdict: string; pr_url: string; rev: string }>,
): string | null {
  if (c.last_pr_url) return `open PR already logged (${c.last_pr_url})`;
  const local = failedOrOpen.get(c.flag_key);
  if (local?.pr_url) return `open PR already logged (${local.pr_url})`;
  const lastVerdict = c.last_verdict || local?.verdict;
  const lastRev = c.last_datafile_revision || local?.rev || "";
  const currentRev = c.datafile_revision || "";
  if (lastVerdict === "failed" && lastRev && lastRev === currentRev) {
    return `failed on same datafile_revision=${lastRev}`;
  }
  return null;
}

function toResult(row: PipeRow & { "d.flag_key"?: string }): SafetyCheckResult {
  const flagKey = row.flag_key || row["d.flag_key"] || "";
  return {
    flag_key: flagKey,
    verdict: row.verdict as Verdict,
    route: row.route as Route,
    reason: row.reason,
    target_value: row.target_value,
    collapse_direction: row.collapse_direction as CollapseDirection,
    datafile_revision: row.datafile_revision,
    evidence: {
      evaluated_events: row.evaluated_events,
      blocked_events: row.blocked_events,
      descendant_count: row.descendant_count,
      evaluating_share: row.evaluating_share,
      rollout_percentage: row.rollout_percentage,
      parent_key: row.parent_key,
      datafile_revision: row.datafile_revision,
      source: "tinybird",
    },
  };
}

async function loadFromTinybird(): Promise<{
  candidates: CandidateRow[];
  reports: SafetyCheckResult[];
}> {
  const candidates = await callTinybirdEndpoint<CandidateRow>("flag_candidates", {
    environment: "production",
    window_days: 90,
  });
  const reports = (
    await callTinybirdEndpoint<PipeRow>("cleanup_report", {
      environment: "production",
      window_days: 90,
    })
  ).map(toResult);
  return { candidates, reports };
}

async function loadFromLocal(): Promise<{
  candidates: CandidateRow[];
  reports: SafetyCheckResult[];
  decisions: Array<{
    flag_key: string;
    verdict: string;
    pr_url: string;
    datafile_revision?: string;
  }>;
}> {
  const store = await loadStore();
  const candidates = listCandidates(store).map((c) => ({
    flag_key: c.flag_key,
    route: c.route,
    datafile_revision: c.datafile_revision,
    last_verdict: undefined as string | undefined,
    last_pr_url: undefined as string | undefined,
    last_datafile_revision: undefined as string | undefined,
  }));
  // Attach latest local decisions for skip logic
  const latest = new Map<
    string,
    { verdict: string; pr_url: string; rev: string }
  >();
  for (const d of store.decisions) {
    latest.set(d.flag_key, {
      verdict: d.verdict,
      pr_url: d.pr_url,
      rev: d.datafile_revision ?? "",
    });
  }
  for (const c of candidates) {
    const d = latest.get(c.flag_key);
    if (!d) continue;
    c.last_verdict = d.verdict;
    c.last_pr_url = d.pr_url;
    c.last_datafile_revision = d.rev;
  }
  return {
    candidates,
    reports: cleanupReport(store),
    decisions: store.decisions,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.filter((a) => a !== "--");
  const dryRun = argv.includes("--dry-run") || !argv.includes("--full");
  const full = argv.includes("--full");
  const emitJson = argv.includes("--emit-json");
  const noDispatch =
    argv.includes("--no-dispatch") ||
    emitJson ||
    process.env.AGENT_ORCHESTRATOR === "stepfunctions";
  const tinybird = useTinybird() || argv.includes("--tinybird");
  const id = runId();
  console.log(
    `Scout run_id=${id} dryRun=${dryRun || !full} source=${tinybird ? "tinybird-rest" : "local"} dispatch=${!noDispatch}\n`,
  );

  const localMeta = tinybird ? null : await loadFromLocal();
  const remote = tinybird ? await loadFromTinybird() : null;
  const candidates = tinybird ? remote!.candidates : localMeta!.candidates;
  const reports = tinybird ? remote!.reports : localMeta!.reports;
  const reportByKey = new Map(reports.map((r) => [r.flag_key, r]));

  const failedOrOpen = new Map<
    string,
    { verdict: string; pr_url: string; rev: string }
  >();
  if (localMeta) {
    for (const d of localMeta.decisions) {
      failedOrOpen.set(d.flag_key, {
        verdict: d.verdict,
        pr_url: d.pr_url,
        rev: d.datafile_revision ?? "",
      });
    }
  }

  const results: SafetyCheckResult[] = [];
  for (const c of candidates) {
    const skip = shouldSkip(c, failedOrOpen);
    if (skip) {
      console.log(`skip ${c.flag_key} (${skip})`);
      continue;
    }
    const report = reportByKey.get(c.flag_key);
    if (!report) continue;
    results.push(report);
    console.log(
      `${c.flag_key.padEnd(24)} route=${report.route.padEnd(10)} ${report.verdict.padEnd(16)} ${report.collapse_direction}`,
    );
    console.log(`  ${report.reason}`);
  }

  const decisions = results.map((r) => ({
    decided_at: new Date().toISOString(),
    run_id: id,
    flag_key: r.flag_key,
    verdict: r.verdict,
    route: r.route,
    reason: r.reason,
    evidence: JSON.stringify(r.evidence),
    pr_url: "",
    datafile_revision: r.datafile_revision ?? "",
  }));

  const safe = results.filter(
    (r) =>
      r.verdict === "safe_to_remove" && r.collapse_direction !== "none",
  );

  if (dryRun || !full) {
    console.log(
      `\nProposed surgeon actions: ${
        safe.map((r) => r.flag_key).join(", ") || "(none)"
      }`,
    );
    console.log(
      "Re-run with --full to write cleanup_decision_log and dispatch surgeons.",
    );
    if (emitJson) writeOrchestratorOutput(id, results, safe);
    return;
  }

  await appendDecisions(decisions);

  if (emitJson || noDispatch) {
    writeOrchestratorOutput(id, results, safe);
    console.log(
      `\nOrchestrator mode: wrote ${safe.length} candidate(s); skipping in-process surgeon dispatch.`,
    );
    return;
  }

  for (const r of safe) {
    const payload = Buffer.from(JSON.stringify({ ...r, run_id: id })).toString(
      "base64url",
    );
    console.log(`\nDispatching surgeon for ${r.flag_key}…`);
    const proc = spawnSync(
      "pnpm",
      [
        "--filter",
        "@stale-flags/surgeon",
        "start",
        "--",
        `--payload=${payload}`,
      ],
      { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (proc.status !== 0) {
      console.error(`Surgeon failed for ${r.flag_key}`);
    }
  }
}

function writeOrchestratorOutput(
  runIdValue: string,
  results: SafetyCheckResult[],
  safe: SafetyCheckResult[],
): void {
  // Independently safe only (already filtered). Leaf-first among parent edges
  // when present; no inventing inconclusive children onto the plan.
  const byKey = new Map(safe.map((r) => [r.flag_key, r]));
  const parentOf = (r: SafetyCheckResult): string =>
    String(r.evidence?.parent_key ?? "");
  const sorted = [...safe].sort((a, b) => {
    const aParent = parentOf(a);
    const bParent = parentOf(b);
    if (aParent && byKey.has(aParent) && aParent === b.flag_key) return -1;
    if (bParent && byKey.has(bParent) && bParent === a.flag_key) return 1;
    return a.flag_key.localeCompare(b.flag_key);
  });
  const out = {
    run_id: runIdValue,
    branch_name: `agent/cleanup-${runIdValue}`,
    candidates: sorted.map((r) => ({
      flag_key: r.flag_key,
      verdict: r.verdict,
      route: r.route,
      collapse_direction: r.collapse_direction,
      target_value: r.target_value,
      reason: r.reason,
      datafile_revision: r.datafile_revision ?? "",
      parent_key: parentOf(r),
      payload_b64: Buffer.from(
        JSON.stringify({ ...r, run_id: runIdValue }),
      ).toString("base64url"),
    })),
    skipped: results
      .filter((r) => !safe.some((s) => s.flag_key === r.flag_key))
      .map((r) => ({
        flag_key: r.flag_key,
        verdict: r.verdict,
        route: r.route,
      })),
  };
  const json = `${JSON.stringify(out)}\n`;
  const dest = process.env.RESULT_S3_URI;
  if (dest?.startsWith("s3://")) {
    const put = spawnSync("aws", ["s3", "cp", "-", dest], {
      input: json,
      encoding: "utf8",
      cwd: root,
    });
    if (put.status !== 0) {
      throw new Error(
        `Failed to write scout result to ${dest}: ${put.stderr || put.stdout}`,
      );
    }
    console.log(`Wrote scout result to ${dest}`);
  }
  console.log(`ORCHESTRATOR_JSON:${JSON.stringify(out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
