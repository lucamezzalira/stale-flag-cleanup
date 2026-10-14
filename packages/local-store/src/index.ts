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

export async function appendDecisions(rows: object[]): Promise<void> {
  const existing = await readJsonl<object>("cleanup_decision_log.ndjson");
  await writeJsonl("cleanup_decision_log.ndjson", [...existing, ...rows]);
}

export async function loadStore(): Promise<
  EvidenceStore & {
    decisions: Array<{
      decided_at: string;
      run_id: string;
      flag_key: string;
      verdict: string;
      reason: string;
      evidence: string;
      pr_url: string;
    }>;
  }
> {
  const definitions = await readJsonl<FlagDefinition>("flag_definitions.ndjson");
  const activity = await readJsonl<DailyActivity>("flag_daily_activity.ndjson");
  const adoption = await readJsonl<BuildAdoption>("build_adoption.ndjson");
  const decisions = await readJsonl<{
    decided_at: string;
    run_id: string;
    flag_key: string;
    verdict: string;
    reason: string;
    evidence: string;
    pr_url: string;
  }>("cleanup_decision_log.ndjson");
  return { definitions, activity, adoption, decisions };
}

export async function ingestToTinybird(
  name: string,
  rows: object[],
): Promise<void> {
  const host = process.env.TINYBIRD_API_HOST ?? "https://api.tinybird.co";
  const token =
    process.env.TINYBIRD_APPEND_TOKEN ?? process.env.TINYBIRD_TOKEN ?? "";
  if (!token || rows.length === 0) return;
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
