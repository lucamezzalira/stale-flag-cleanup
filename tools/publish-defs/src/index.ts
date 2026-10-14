import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import {
  deriveTargetValue,
  parentKeyFromRequired,
} from "@stale-flags/defs-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const featuresDir = path.join(root, "featurevisor/features");
const environment = process.env.FEATUREVISOR_ENV ?? "production";

type FeatureYaml = {
  deprecated?: boolean;
  archived?: boolean;
  requiredFeatures?: unknown;
  required?: unknown;
  variations?: Array<{ value: string; weight?: number }>;
  rules?: Record<string, Array<{ percentage: number }>>;
};

export interface FlagDefinitionRow {
  captured_at: string;
  datafile_revision: string;
  flag_key: string;
  parent_key: string;
  rollout_percentage: number;
  target_value: string;
  variation_count: number;
  deprecated: number;
  archived: number;
  environment: string;
}

async function readRevision(): Promise<string> {
  try {
    const revPath = path.join(root, "featurevisor/datafiles/REVISION");
    return (await readFile(revPath, "utf8")).trim();
  } catch {
    return `local-${Date.now()}`;
  }
}

export async function loadFlagDefinitions(
  capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
): Promise<FlagDefinitionRow[]> {
  const revision = await readRevision();
  const files = (await readdir(featuresDir)).filter((f) => f.endsWith(".yml"));
  const rows: FlagDefinitionRow[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(featuresDir, file), "utf8");
    const doc = yaml.load(raw) as FeatureYaml;
    const flagKey = file.replace(/\.yml$/, "");
    const rules = doc.rules?.[environment] ?? [];
    const rollout = rules.length > 0 ? rules[0].percentage : 0;
    const variationCount = doc.variations?.length
      ? doc.variations.length
      : 1;
    const { targetValue } = deriveTargetValue({
      rolloutPercentage: rollout,
      variationCount,
    });

    rows.push({
      captured_at: capturedAt,
      datafile_revision: revision,
      flag_key: flagKey,
      parent_key: parentKeyFromRequired(doc.requiredFeatures ?? doc.required),
      rollout_percentage: rollout,
      target_value: targetValue,
      variation_count: variationCount,
      deprecated: doc.deprecated ? 1 : 0,
      archived: doc.archived ? 1 : 0,
      environment,
    });
  }

  return rows.sort((a, b) => a.flag_key.localeCompare(b.flag_key));
}

async function postRows(rows: FlagDefinitionRow[]): Promise<void> {
  const host = process.env.TINYBIRD_API_HOST ?? "https://api.tinybird.co";
  const token =
    process.env.TINYBIRD_APPEND_TOKEN ?? process.env.TINYBIRD_TOKEN ?? "";
  if (!token) {
    console.log(JSON.stringify(rows, null, 2));
    console.error(
      "No TINYBIRD_APPEND_TOKEN/TINYBIRD_TOKEN; printed rows only (dry).",
    );
    return;
  }
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const res = await fetch(
    `${host.replace(/\/$/, "")}/v0/events?name=flag_definitions&wait=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-ndjson",
      },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`publish-defs failed: ${res.status} ${await res.text()}`);
  }
  console.log(`Published ${rows.length} flag_definitions rows`);
}

async function main(): Promise<void> {
  const capturedAt =
    process.env.CAPTURED_AT ??
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows = await loadFlagDefinitions(capturedAt);
  await postRows(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
