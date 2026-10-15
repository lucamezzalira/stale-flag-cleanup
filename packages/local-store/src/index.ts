import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuildAdoption,
  DailyActivity,
  EvidenceStore,
  FlagDefinition,
} from "@stale-flags/verdicts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.resolve(__dirname, "../../../.local-data");

export type DecisionRow = {
  decided_at: string;
  run_id: string;
  flag_key: string;
  verdict: string;
  route?: string;
  reason: string;
  evidence: string;
  pr_url: string;
  datafile_revision?: string;
};

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(path.join(dataDir, file), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function writeJsonl(file: string, rows: object[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, file),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
}

export async function clearLocalData(): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
}

export async function saveSeed(input: {
  definitions: FlagDefinition[];
  activity: DailyActivity[];
  adoption: BuildAdoption[];
  decisions?: object[];
}): Promise<void> {
  await writeJsonl("flag_definitions.ndjson", input.definitions);
  await writeJsonl("flag_daily_activity.ndjson", input.activity);
  await writeJsonl("build_adoption.ndjson", input.adoption);
  await writeJsonl("cleanup_decision_log.ndjson", input.decisions ?? []);
}

export async function appendDecisions(rows: DecisionRow[]): Promise<void> {
  const normalized = rows.map((r) => ({
    ...r,
    route: r.route ?? "",
    datafile_revision: r.datafile_revision ?? "",
    decided_at: r.decided_at.includes(".")
      ? r.decided_at
      : r.decided_at.replace("Z", ".000Z"),
  }));
  const existing = await readJsonl<DecisionRow>("cleanup_decision_log.ndjson");
  await writeJsonl("cleanup_decision_log.ndjson", [
    ...existing,
    ...normalized,
  ]);
  await ingestToTinybird("cleanup_decision_log", normalized);
}

export async function loadStore(): Promise<
  EvidenceStore & { decisions: DecisionRow[] }
> {
  const definitions = await readJsonl<FlagDefinition>("flag_definitions.ndjson");
  const activity = await readJsonl<DailyActivity>("flag_daily_activity.ndjson");
  const adoption = await readJsonl<BuildAdoption>("build_adoption.ndjson");
  const decisions = await readJsonl<DecisionRow>("cleanup_decision_log.ndjson");
  const firstSeen: Record<string, string> = {};
  for (const a of activity) {
    if (a.app !== "web") continue;
    const prev = firstSeen[a.flag_key];
    if (!prev || a.day < prev) firstSeen[a.flag_key] = a.day;
  }
  return { definitions, activity, adoption, decisions, firstSeen };
}

async function loadDotEnvOnce(): Promise<void> {
  if ((globalThis as { __staleFlagsDotEnv?: boolean }).__staleFlagsDotEnv) return;
  (globalThis as { __staleFlagsDotEnv?: boolean }).__staleFlagsDotEnv = true;
  try {
    const envPath = path.resolve(dataDir, "../.env");
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env */
  }
}

async function resolveAdminToken(host: string): Promise<string> {
  await loadDotEnvOnce();
  if (process.env.TINYBIRD_ADMIN_TOKEN) return process.env.TINYBIRD_ADMIN_TOKEN;
  // Workspace admin token lives in .tinyb after `tb login` (not the scoped endpoint_read token).
  try {
    const tinybPaths = [
      path.resolve(dataDir, "../.tinyb"),
      path.resolve(dataDir, "../tinybird/.tinyb"),
    ];
    for (const p of tinybPaths) {
      try {
        const raw = await readFile(p, "utf8");
        const parsed = JSON.parse(raw) as { token?: string; host?: string };
        if (parsed.token && (!parsed.host || host.includes(new URL(parsed.host).host) || parsed.host === host)) {
          return parsed.token;
        }
        if (parsed.token) return parsed.token;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

export async function truncateTinybirdDatasources(
  names: string[],
): Promise<void> {
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const token = await resolveAdminToken(host);
  if (!token) {
    if (process.env.TINYBIRD_APPEND_TOKEN || process.env.TINYBIRD_TOKEN) {
      throw new Error(
        "Tinybird truncate requires TINYBIRD_ADMIN_TOKEN or a .tinyb admin token (scoped endpoint_read/append tokens cannot TRUNCATE)",
      );
    }
    console.warn("No Tinybird credentials; skip Tinybird truncate");
    return;
  }
  for (const name of names) {
    // Prefer SQL TRUNCATE (admin token). Datasource truncate API needs DATASOURCES:CREATE.
    const sqlRes = await fetch(`${host.replace(/\/$/, "")}/v0/sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `q=${encodeURIComponent(`TRUNCATE TABLE ${name}`)}`,
    });
    if (sqlRes.ok) {
      console.log(`Truncated Tinybird datasource ${name}`);
      continue;
    }
    const sqlText = await sqlRes.text();
    const res = await fetch(
      `${host.replace(/\/$/, "")}/v0/datasources/${encodeURIComponent(name)}/truncate`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `Tinybird truncate ${name}: sql=${sqlRes.status} ${sqlText}; api=${res.status} ${text}`,
      );
    }
    console.log(`Truncated Tinybird datasource ${name}`);
  }
}

export const DEMO_TINYBIRD_TABLES = [
  "cleanup_decision_log",
  "flag_definitions",
  "flag_daily_activity",
  "flag_evaluations",
  "build_adoption",
  "session_beacons",
] as const;

export async function ingestToTinybird(
  name: string,
  rows: object[],
): Promise<void> {
  await loadDotEnvOnce();
  const host =
    process.env.TINYBIRD_API_HOST ?? "https://api.us-east.aws.tinybird.co";
  const token =
    process.env.TINYBIRD_APPEND_TOKEN ?? process.env.TINYBIRD_TOKEN ?? "";
  if (!token || rows.length === 0) {
    if (rows.length > 0 && !token) {
      console.warn(
        `Skip Tinybird ingest ${name}: no TINYBIRD_APPEND_TOKEN / TINYBIRD_TOKEN`,
      );
    }
    return;
  }
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const body = rows
      .slice(i, i + chunk)
      .map((r) => JSON.stringify(r))
      .join("\n");
    const res = await fetch(
      `${host.replace(/\/$/, "")}/v0/events?name=${name}&wait=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-ndjson",
        },
        body,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Tinybird ingest ${name}: ${res.status} ${text}`);
    }
    try {
      const parsed = JSON.parse(text) as {
        successful_rows?: number;
        quarantined_rows?: number;
      };
      if ((parsed.quarantined_rows ?? 0) > 0) {
        throw new Error(
          `Tinybird ingest ${name}: quarantined ${parsed.quarantined_rows} rows (${text})`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Tinybird ingest")) {
        throw err;
      }
    }
  }
}
