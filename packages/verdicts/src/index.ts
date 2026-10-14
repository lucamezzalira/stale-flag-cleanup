import { collapseDirectionFromTarget } from "@stale-flags/defs-utils";

export type Verdict = "safe_to_remove" | "blocked" | "inconclusive" | "failed";
export type Route = "lifecycle" | "abandoned" | "settled" | "none";
export type CollapseDirection =
  | "keep_gated_branch"
  | "delete_gated_branch"
  | "none";

export interface FlagDefinition {
  flag_key: string;
  parent_key: string;
  rollout_percentage: number;
  target_value: string;
  variation_count: number;
  deprecated: number;
  archived: number;
  environment: string;
  captured_at: string;
  datafile_revision?: string;
}

export interface DailyActivity {
  day: string;
  flag_key: string;
  app: string;
  build_id: string;
  outcome: string;
  variation: string;
  event_count: number;
}

export interface BuildAdoption {
  snapshot_date: string;
  app: string;
  build_id: string;
  released_at: string;
  active_sessions: number;
  session_share: number;
}

export interface SafetyCheckParams {
  flag_key: string;
  window_days?: number;
  min_session_share?: number;
  min_events_for_settled?: number;
  min_events_floor?: number;
  environment?: string;
  now?: Date;
}

export interface SafetyCheckResult {
  flag_key: string;
  verdict: Verdict;
  route: Route;
  reason: string;
  target_value: string;
  collapse_direction: CollapseDirection;
  evidence: Record<string, unknown>;
}

export interface EvidenceStore {
  definitions: FlagDefinition[];
  activity: DailyActivity[];
  adoption: BuildAdoption[];
  firstSeen?: Record<string, string>;
}

function latestDefs(
  store: EvidenceStore,
  environment: string,
): Map<string, FlagDefinition> {
  const map = new Map<string, FlagDefinition>();
  for (const row of store.definitions) {
    if (row.environment !== environment) continue;
    const prev = map.get(row.flag_key);
    if (!prev || row.captured_at >= prev.captured_at) {
      map.set(row.flag_key, row);
    }
  }
  return map;
}

function descendantsOf(
  flagKey: string,
  defs: Map<string, FlagDefinition>,
): string[] {
  const kids: string[] = [];
  for (const d of defs.values()) {
    if (d.parent_key === flagKey && d.archived === 0) kids.push(d.flag_key);
  }
  const all = [...kids];
  for (const k of kids) {
    all.push(...descendantsOf(k, defs));
  }
  return all;
}

function inWindow(day: string, start: Date, end: Date): boolean {
  const d = new Date(`${day}T00:00:00Z`);
  return d >= start && d <= end;
}

export function runSafetyCheck(
  store: EvidenceStore,
  params: SafetyCheckParams,
): SafetyCheckResult {
  const windowDays = params.window_days ?? 90;
  const minShare = params.min_session_share ?? 0.005;
  const minSettled = params.min_events_for_settled ?? 1000;
  const minFloor = params.min_events_floor ?? 20;
  const environment = params.environment ?? "production";
  const now = params.now ?? new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const defs = latestDefs(store, environment);
  const def = defs.get(params.flag_key);
  const collapse = collapseDirectionFromTarget(def?.target_value ?? "");

  const baseEvidence: Record<string, unknown> = {
    window_days: windowDays,
    min_session_share: minShare,
    min_events_for_settled: minSettled,
  };

  if (!def) {
    return {
      flag_key: params.flag_key,
      verdict: "blocked",
      route: "none",
      reason: `Flag ${params.flag_key} is no longer in the project definitions snapshot, so there is nothing to remove.`,
      target_value: "",
      collapse_direction: "none",
      evidence: baseEvidence,
    };
  }

  baseEvidence.rollout_percentage = def.rollout_percentage;
  baseEvidence.deprecated = def.deprecated;
  baseEvidence.archived = def.archived;
  baseEvidence.parent_key = def.parent_key;

  const activity = store.activity.filter(
    (a) =>
      a.flag_key === params.flag_key &&
      a.app === "web" &&
      inWindow(a.day, windowStart, now),
  );
  const evaluated = activity.filter((a) => a.outcome === "evaluated");
  const blocked = activity.filter((a) => a.outcome === "blocked_by_parent");
  const evaluatedCount = evaluated.reduce((s, a) => s + a.event_count, 0);
  const blockedCount = blocked.reduce((s, a) => s + a.event_count, 0);
  const variationCounts = new Map<string, number>();
  for (const a of evaluated) {
    if (!a.variation) continue;
    variationCounts.set(
      a.variation,
      (variationCounts.get(a.variation) ?? 0) + a.event_count,
    );
  }
  baseEvidence.evaluated_events = evaluatedCount;
  baseEvidence.blocked_events = blockedCount;
  baseEvidence.variation_counts = Object.fromEntries(variationCounts);

  const descendants = descendantsOf(params.flag_key, defs);
  baseEvidence.descendants = descendants;

  // Parent-gated quiet flags: inconclusive before descendant blocking so nested
  // children surface the gating story (PRD acceptance for wishlist_*).
  const parentGated =
    Boolean(def.parent_key) && blockedCount > 0 && evaluatedCount === 0;

  if (parentGated) {
    return {
      flag_key: params.flag_key,
      verdict: "inconclusive",
      route: "abandoned",
      reason: `Flag ${params.flag_key} was never evaluated in the window because parent ${def.parent_key} gated every lookup (${blockedCount} blocked_by_parent events). Absence of evaluations is not evidence of disuse.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  if (descendants.length > 0) {
    return {
      flag_key: params.flag_key,
      verdict: "blocked",
      route: def.deprecated || def.archived ? "lifecycle" : "abandoned",
      reason: `Flag ${params.flag_key} still has living descendants (${descendants.join(", ")}). Removal must proceed bottom up.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  // Mid-ramp / multi-variation refuse when there is real traffic or multiple variations.
  // Sparse low-percentage flags fall through to thin-evidence instead.
  if (
    !def.target_value &&
    (def.variation_count > 1 || evaluatedCount >= minFloor)
  ) {
    return {
      flag_key: params.flag_key,
      verdict: "blocked",
      route: def.deprecated || def.archived ? "lifecycle" : "settled",
      reason: `Flag ${params.flag_key} is mid-ramp at ${def.rollout_percentage}% (or multi-variation) with no single target_value, so the code cannot be collapsed safely.`,
      target_value: "",
      collapse_direction: "none",
      evidence: baseEvidence,
    };
  }

  if (def.deprecated === 1 || def.archived === 1) {
    if (!def.target_value) {
      return {
        flag_key: params.flag_key,
        verdict: "blocked",
        route: "lifecycle",
        reason: `Flag ${params.flag_key} is marked for removal but has no single target_value to collapse to.`,
        target_value: "",
        collapse_direction: "none",
        evidence: baseEvidence,
      };
    }
    return {
      flag_key: params.flag_key,
      verdict: "safe_to_remove",
      route: "lifecycle",
      reason: `Featurevisor marked ${params.flag_key} as ${def.deprecated ? "deprecated" : "archived"}, structural checks passed, and target_value=${def.target_value} supports collapse_direction=${collapse}.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  const evalByBuild = new Map<string, number>();
  for (const a of evaluated) {
    evalByBuild.set(
      a.build_id,
      (evalByBuild.get(a.build_id) ?? 0) + a.event_count,
    );
  }
  const liveHits: Array<{
    build_id: string;
    session_share: number;
    evaluated_events: number;
    released_at: string;
  }> = [];
  for (const [buildId, count] of evalByBuild) {
    const shares = store.adoption.filter(
      (b) =>
        b.build_id === buildId &&
        b.app === "web" &&
        inWindow(b.snapshot_date, windowStart, now),
    );
    const maxShare = shares.reduce((m, s) => Math.max(m, s.session_share), 0);
    const released =
      shares.map((s) => s.released_at).sort()[0] ?? "";
    if (maxShare >= minShare && count > 0) {
      liveHits.push({
        build_id: buildId,
        session_share: maxShare,
        evaluated_events: count,
        released_at: released,
      });
    }
  }
  baseEvidence.live_build_hits = liveHits;

  // Stale-bundle guard (abandoned only): evaluations only on a minority cohort.
  const evaluatingShare = liveHits.reduce((s, h) => s + h.session_share, 0);
  // Settled requires majority-fleet traffic, not only a sticky old build.
  const settledShape =
    evaluatedCount >= minSettled &&
    variationCounts.size === 1 &&
    (def.rollout_percentage === 0 || def.rollout_percentage === 100) &&
    evaluatingShare >= 0.5;

  if (
    evaluatedCount > 0 &&
    liveHits.length > 0 &&
    evaluatingShare < 0.5
  ) {
    const hit = liveHits.sort((a, b) => b.session_share - a.session_share)[0];
    const daily = Math.round(hit.evaluated_events / Math.max(windowDays, 1));
    return {
      flag_key: params.flag_key,
      verdict: "blocked",
      route: "abandoned",
      reason: `Flag ${params.flag_key} is still evaluated by live build ${hit.build_id} (released ${hit.released_at}, session_share=${hit.session_share.toFixed(3)}, ~${daily} evaluated events/day).`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  const firstSeen =
    store.firstSeen?.[params.flag_key] ??
    activity.map((a) => a.day).sort()[0];
  const totalEvents = evaluatedCount + blockedCount;
  if (
    (totalEvents > 0 && totalEvents < minFloor) ||
    (firstSeen && new Date(`${firstSeen}T00:00:00Z`) >= windowStart)
  ) {
    if (totalEvents > 0 && totalEvents < minFloor) {
      return {
        flag_key: params.flag_key,
        verdict: "inconclusive",
        route: "abandoned",
        reason: `Flag ${params.flag_key} has only ${totalEvents} events in the ${windowDays}-day window, which is too thin to support a removal decision.`,
        target_value: def.target_value,
        collapse_direction: collapse,
        evidence: baseEvidence,
      };
    }
  }
  // Thin evaluated-only path for search_ranking style
  if (evaluatedCount > 0 && evaluatedCount < minFloor) {
    return {
      flag_key: params.flag_key,
      verdict: "inconclusive",
      route: "abandoned",
      reason: `Flag ${params.flag_key} has only ${evaluatedCount} evaluated events in the ${windowDays}-day window, which is too thin to support a removal decision.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  if (evaluatedCount === 0) {
    return {
      flag_key: params.flag_key,
      verdict: "safe_to_remove",
      route: "abandoned",
      reason: `Flag ${params.flag_key} had zero evaluated events in the last ${windowDays} days, no live-build hits, and target_value=${def.target_value} supports ${collapse}.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  if (settledShape) {
    const only = [...variationCounts.keys()][0];
    return {
      flag_key: params.flag_key,
      verdict: "safe_to_remove",
      route: "settled",
      reason: `Flag ${params.flag_key} is settled: ${evaluatedCount} evaluations in ${windowDays} days all returned variation=${only}, rollout=${def.rollout_percentage}%, collapse=${collapse}.`,
      target_value: def.target_value,
      collapse_direction: collapse,
      evidence: baseEvidence,
    };
  }

  return {
    flag_key: params.flag_key,
    verdict: "inconclusive",
    route: "none",
    reason: `Flag ${params.flag_key} did not qualify as abandoned or settled under current thresholds.`,
    target_value: def.target_value,
    collapse_direction: collapse,
    evidence: baseEvidence,
  };
}

export function listCandidates(
  store: EvidenceStore,
  opts?: {
    window_days?: number;
    environment?: string;
    min_events_for_settled?: number;
  },
): Array<{
  flag_key: string;
  route: Route;
  evaluated_events: number;
  blocked_events: number;
  distinct_variations: number;
  parent_key: string;
  descendant_count: number;
}> {
  const environment = opts?.environment ?? "production";
  const windowDays = opts?.window_days ?? 90;
  const minSettled = opts?.min_events_for_settled ?? 1000;
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
  const defs = latestDefs(store, environment);

  const out = [];
  for (const def of defs.values()) {
    if (def.archived === 1) continue;
    const activity = store.activity.filter(
      (a) =>
        a.flag_key === def.flag_key &&
        a.app === "web" &&
        inWindow(a.day, windowStart, now),
    );
    const evaluated_events = activity
      .filter((a) => a.outcome === "evaluated")
      .reduce((s, a) => s + a.event_count, 0);
    const blocked_events = activity
      .filter((a) => a.outcome === "blocked_by_parent")
      .reduce((s, a) => s + a.event_count, 0);
    const variations = new Set(
      activity
        .filter((a) => a.outcome === "evaluated" && a.variation)
        .map((a) => a.variation),
    );
    const lifecycle = def.deprecated === 1 || def.archived === 1;
    const settled =
      evaluated_events >= minSettled &&
      variations.size === 1 &&
      (def.rollout_percentage === 0 || def.rollout_percentage === 100);
    // Demo returns all non-archived flags as candidates; route prefers lifecycle, then settled, else abandoned.
    const route = (lifecycle
      ? "lifecycle"
      : settled || (def.variation_count > 1 && def.rollout_percentage > 0 && def.rollout_percentage < 100)
        ? "settled"
        : "abandoned") as Route;
    out.push({
      flag_key: def.flag_key,
      route,
      evaluated_events,
      blocked_events,
      distinct_variations: variations.size,
      parent_key: def.parent_key,
      descendant_count: descendantsOf(def.flag_key, defs).length,
    });
  }
  return out.sort((a, b) => a.flag_key.localeCompare(b.flag_key));
}

export function cleanupReport(
  store: EvidenceStore,
  opts?: SafetyCheckParams,
): SafetyCheckResult[] {
  const candidates = listCandidates(store, opts);
  return candidates.map((c) =>
    runSafetyCheck(store, { ...opts, flag_key: c.flag_key }),
  );
}
