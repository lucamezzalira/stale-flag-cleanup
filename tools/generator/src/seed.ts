import {
  clearLocalData,
  DEMO_TINYBIRD_TABLES,
  ingestToTinybird,
  saveSeed,
  truncateTinybirdDatasources,
} from "@stale-flags/local-store";
import {
  cleanupReport,
  type BuildAdoption,
  type DailyActivity,
  type FlagDefinition,
} from "@stale-flags/verdicts";
import {
  deriveTargetValue,
  parentKeyFromRequired,
} from "@stale-flags/defs-utils";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { createRng } from "./rng.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function loadFlagDefinitions(capturedAt: string): Promise<FlagDefinition[]> {
  const featuresDir = path.join(root, "featurevisor/features");
  const files = (await readdir(featuresDir)).filter((f) => f.endsWith(".yml"));
  let revision = `local-${Date.now()}`;
  try {
    revision = (await readFile(path.join(root, "featurevisor/datafiles/REVISION"), "utf8")).trim();
  } catch {
    /* ignore */
  }
  const rows: FlagDefinition[] = [];
  for (const file of files) {
    const doc = yaml.load(await readFile(path.join(featuresDir, file), "utf8")) as {
      deprecated?: boolean;
      archived?: boolean;
      requiredFeatures?: unknown;
      required?: unknown;
      variations?: unknown[];
      rules?: Record<string, Array<{ percentage: number }>>;
    };
    const flag_key = file.replace(/\.yml$/, "");
    const rollout = doc.rules?.production?.[0]?.percentage ?? 0;
    const variation_count = doc.variations?.length ? doc.variations.length : 1;
    const { targetValue } = deriveTargetValue({
      rolloutPercentage: rollout,
      variationCount: variation_count,
    });
    rows.push({
      captured_at: capturedAt,
      datafile_revision: revision,
      flag_key,
      parent_key: parentKeyFromRequired(doc.requiredFeatures ?? doc.required),
      rollout_percentage: rollout,
      target_value: targetValue,
      variation_count,
      deprecated: doc.deprecated ? 1 : 0,
      archived: doc.archived ? 1 : 0,
      environment: "production",
    });
  }
  void revision;
  return rows.sort((a, b) => a.flag_key.localeCompare(b.flag_key));
}

function parseArgs(argv: string[]): { days: number; seed: number } {
  let days = Number(process.env.SEED_DAYS ?? 90);
  let seed = Number(process.env.SEED ?? 42);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") days = Number(argv[++i]);
    if (argv[i] === "--seed") seed = Number(argv[++i]);
  }
  return { days, seed };
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hourWeight(hour: number, weekday: number): number {
  // Quieter overnight, weekday peak, weekend lower
  const diurnal = [
    0.2, 0.15, 0.1, 0.1, 0.15, 0.3, 0.5, 0.7, 0.9, 1, 1, 1.05, 1.1, 1.05, 1,
    0.95, 0.9, 0.85, 0.8, 0.7, 0.55, 0.4, 0.3, 0.25,
  ][hour]!;
  const week = weekday === 0 || weekday === 6 ? 0.7 : 1;
  return diurnal * week;
}

async function main(): Promise<void> {
  const { days, seed } = parseArgs(process.argv.slice(2));
  const rng = createRng(seed);
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  console.log(`Seeding ${days} days with seed=${seed}…`);

  // Weekly builds; one sticky old build ~90d ago retaining 2–4% share
  const builds: Array<{ id: string; released: Date }> = [];
  const stickyReleased = new Date(now);
  stickyReleased.setUTCDate(stickyReleased.getUTCDate() - Math.min(days, 90) + 5);
  const stickyId = `${dayString(stickyReleased)}.oldcafe1`;
  builds.push({ id: stickyId, released: stickyReleased });

  for (let d = days; d >= 0; d -= 7) {
    const released = new Date(now);
    released.setUTCDate(released.getUTCDate() - d);
    const short = Math.floor(rng() * 0xfffff).toString(16).padStart(5, "0");
    builds.push({ id: `${dayString(released)}.${short}`, released });
  }
  builds.sort((a, b) => a.released.getTime() - b.released.getTime());

  const adoption: BuildAdoption[] = [];
  const activity: DailyActivity[] = [];

  const bump = (
    day: string,
    flag: string,
    buildId: string,
    outcome: string,
    variation: string,
    count: number,
  ) => {
    if (count <= 0) return;
    const existing = activity.find(
      (a) =>
        a.day === day &&
        a.flag_key === flag &&
        a.build_id === buildId &&
        a.outcome === outcome &&
        a.variation === variation,
    );
    if (existing) existing.event_count += count;
    else {
      activity.push({
        day,
        flag_key: flag,
        app: "web",
        build_id: buildId,
        outcome,
        variation,
        event_count: count,
      });
    }
  };

  for (let offset = days; offset >= 0; offset--) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - offset);
    const ds = dayString(day);
    const growth = 1 + ((days - offset) / days) * 0.25;
    const wobble = 0.85 + rng() * 0.3;
    const baseSessions = Math.floor(800 * growth * wobble);

    // Build share: newer builds dominate; sticky keeps 0.02–0.04
    const live = builds.filter((b) => b.released <= day);
    const stickyShare = 0.02 + rng() * 0.02;
    const weights = live.map((b, i) => {
      if (b.id === stickyId) return stickyShare;
      const age = (day.getTime() - b.released.getTime()) / (86400000 * 7);
      return Math.max(0.02, Math.exp(-age * 0.35));
    });
    const nonSticky = weights.reduce(
      (s, w, i) => (live[i]!.id === stickyId ? s : s + w),
      0,
    );
    const shares = live.map((b, i) => {
      if (b.id === stickyId) return stickyShare;
      return ((1 - stickyShare) * weights[i]!) / nonSticky;
    });

    live.forEach((b, i) => {
      adoption.push({
        snapshot_date: ds,
        app: "web",
        build_id: b.id,
        released_at: b.released.toISOString().replace(/\.\d{3}Z$/, "Z"),
        active_sessions: Math.floor(baseSessions * shares[i]!),
        session_share: Number(shares[i]!.toFixed(4)),
      });
    });

    const weekday = day.getUTCDay();
    let dayWeight = 0;
    for (let h = 0; h < 24; h++) dayWeight += hourWeight(h, weekday);
    const sessions = Math.floor(baseSessions * (dayWeight / 24));

    for (const [b, share] of live.map((b, i) => [b, shares[i]!] as const)) {
      const buildSessions = Math.floor(sessions * share);
      const isSticky = b.id === stickyId;
      const isModern = !isSticky;

      // checkout_secure_seal: heavy settled traffic on modern builds (keep_gated, not deprecated)
      if (isModern) {
        bump(
          ds,
          "checkout_secure_seal",
          b.id,
          "evaluated",
          "true",
          buildSessions * 3,
        );
      }

      // nav_winter_ribbon: sticky old build only (deprecated but live minority → blocked)
      if (isSticky) {
        bump(
          ds,
          "nav_winter_ribbon",
          b.id,
          "evaluated",
          "true",
          Math.floor(200 + rng() * 100),
        );
      }

      // shipping_estimator: 60/40 split on modern
      if (isModern) {
        const n = Math.floor(buildSessions * 0.8);
        bump(
          ds,
          "shipping_estimator",
          b.id,
          "evaluated",
          "estimate_compact",
          Math.floor(n * 0.6),
        );
        bump(
          ds,
          "shipping_estimator",
          b.id,
          "evaluated",
          "estimate_detailed",
          Math.floor(n * 0.4),
        );
      }

      // wishlist evaluated (parent off → false), children blocked
      if (isModern) {
        const wish = Math.floor(buildSessions * 0.4);
        bump(ds, "wishlist", b.id, "evaluated", "false", wish);
        bump(
          ds,
          "wishlist_sharing",
          b.id,
          "blocked_by_parent",
          "",
          Math.floor(wish * 0.9),
        );
        bump(
          ds,
          "wishlist_sharing_qr",
          b.id,
          "blocked_by_parent",
          "",
          Math.floor(wish * 0.7),
        );
      }

      // checkout_redesign: only sticky old build
      if (isSticky) {
        bump(
          ds,
          "checkout_redesign",
          b.id,
          "evaluated",
          "true",
          Math.floor(200 + rng() * 100),
        );
      }

      // listing_outlet_banner: only before window (abandoned / delete_gated, not deprecated)
      // search_ranking_v2: sparse — sprinkle later
    }
  }

  // listing_outlet_banner: activity ending before window (abandoned evidence-only)
  for (let offset = days + 40; offset > days + 5; offset--) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - offset);
    const ds = dayString(day);
    const b = builds[0]!;
    bump(ds, "listing_outlet_banner", b.id, "evaluated", "false", 50);
  }

  // checkout_secure_seal: also appear before the window so first_seen is not inside it
  for (let offset = days + 40; offset > days + 5; offset--) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - offset);
    const ds = dayString(day);
    const modern = builds.filter((b) => b.id !== stickyId);
    const b = modern[0] ?? builds[0]!;
    bump(ds, "checkout_secure_seal", b.id, "evaluated", "true", 80);
  }

  // search_ranking_v2: 5–15 evaluated across whole window
  const sparse = 5 + Math.floor(rng() * 11);
  for (let i = 0; i < sparse; i++) {
    const offset = Math.floor(rng() * days);
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - offset);
    const modern = builds.filter((b) => b.id !== stickyId);
    const b = modern[Math.floor(rng() * modern.length)] ?? builds[0]!;
    bump(dayString(day), "search_ranking_v2", b.id, "evaluated", "true", 1);
  }

  // Definitions: captured before window so they "existed before window opened"
  const captured = new Date(now);
  captured.setUTCDate(captured.getUTCDate() - days - 1);
  const definitions = await loadFlagDefinitions(
    captured.toISOString().replace(/\.\d{3}Z$/, "Z"),
  );

  await clearLocalData();
  await saveSeed({ definitions, activity, adoption });

  // Wipe Tinybird Cloud tables so re-seed never stacks history or leftover PRs
  await truncateTinybirdDatasources([...DEMO_TINYBIRD_TABLES]);

  // Mirror into Tinybird (daily activity only; do not also ingest flag_evaluations
  // or the MV would double-count into flag_daily_activity).
  await ingestToTinybird("flag_definitions", definitions);
  await ingestToTinybird("build_adoption", adoption);
  await ingestToTinybird("flag_daily_activity", activity);

  const store = { definitions, activity, adoption };
  const report = cleanupReport(store, { window_days: days });
  console.log("\nVerdict matrix after seed:");
  for (const row of report) {
    const share = Number(row.evidence.evaluating_share ?? 0);
    if (share > 1.0001) {
      throw new Error(
        `evaluating_share out of range for ${row.flag_key}: ${share}`,
      );
    }
    console.log(
      `  ${row.flag_key.padEnd(24)} ${row.verdict.padEnd(16)} ${row.collapse_direction.padEnd(20)} ${row.route}  share=${share.toFixed(3)}`,
    );
  }
  console.log(`\nRows: activity=${activity.length} adoption=${adoption.length} defs=${definitions.length}`);
  console.log(`Local data written to .local-data/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
