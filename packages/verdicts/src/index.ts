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
  datafile_revision?: string;
}

export interface EvidenceStore {
  definitions: FlagDefinition[];
  activity: DailyActivity[];
  adoption: BuildAdoption[];
  firstSeen?: Record<string, string>;
}

export const DEFAULT_SAFETY_PARAMS = {
  window_days: 90,
  min_session_share: 0.005,
  min_events_for_settled: 1000,
  min_events_floor: 20,
  environment: "production",
} as const;

type ResolvedParams = {
  window_days: number;
  min_session_share: number;
  min_events_for_settled: number;
  min_events_floor: number;
  environment: string;
  now: Date;
  windowStart: Date;
};

function resolveParams(
  params?: Partial<SafetyCheckParams> & { now?: Date },
): ResolvedParams {
  const window_days = params?.window_days ?? DEFAULT_SAFETY_PARAMS.window_days;
  const now = params?.now ?? new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - window_days);
  return {
    window_days,
    min_session_share:
      params?.min_session_share ?? DEFAULT_SAFETY_PARAMS.min_session_share,
    min_events_for_settled:
      params?.min_events_for_settled ??
      DEFAULT_SAFETY_PARAMS.min_events_for_settled,
    min_events_floor:
      params?.min_events_floor ?? DEFAULT_SAFETY_PARAMS.min_events_floor,
    environment: params?.environment ?? DEFAULT_SAFETY_PARAMS.environment,
    now,
    windowStart,
  };
}

function buildVerdict(
  flagKey: string,
  def: FlagDefinition | undefined,
  verdict: Verdict,
  route: Route,
  reason: string,
  evidence: Record<string, unknown>,
  collapseOverride?: CollapseDirection,
): SafetyCheckResult {
  const target_value = def?.target_value ?? "";
  const collapse =
    collapseOverride ?? collapseDirectionFromTarget(target_value);
  return {
    flag_key: flagKey,
    verdict,
    route,
    reason,
    target_value,
    collapse_direction: collapse,
    evidence,
    datafile_revision: def?.datafile_revision,
  };
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

export interface FlagWindowSummary {
  evaluatedCount: number;
  blockedCount: number;
  totalEvents: number;
  variationCounts: Map<string, number>;
  activity: DailyActivity[];
  evaluated: DailyActivity[];
  liveHits: Array<{
    build_id: string;
    session_share: number;
    evaluated_events: number;
    released_at: string;
  }>;
  evaluatingShare: number;
  firstSeen: string | undefined;
  descendants: string[];
}

export function aggregateWindow(
  store: EvidenceStore,
  flagKey: string,
  params: ResolvedParams,
  defs: Map<string, FlagDefinition>,
): FlagWindowSummary {
  const activity = store.activity.filter(
    (a) =>
      a.flag_key === flagKey &&
      a.app === "web" &&
      inWindow(a.day, params.windowStart, params.now),
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

  const evalByBuild = new Map<string, number>();
  for (const a of evaluated) {
    evalByBuild.set(
      a.build_id,
      (evalByBuild.get(a.build_id) ?? 0) + a.event_count,
    );
  }
  const liveHits: FlagWindowSummary["liveHits"] = [];
  for (const [buildId, count] of evalByBuild) {
    const shares = store.adoption.filter(
      (b) =>
        b.build_id === buildId &&
        b.app === "web" &&
        inWindow(b.snapshot_date, params.windowStart, params.now),
    );
    const maxShare = shares.reduce((m, s) => Math.max(m, s.session_share), 0);
    const released = shares.map((s) => s.released_at).sort()[0] ?? "";
    if (maxShare >= params.min_session_share && count > 0) {
      liveHits.push({
        build_id: buildId,
        session_share: maxShare,
        evaluated_events: count,
        released_at: released,
      });
    }
  }

  const firstSeen =
    store.firstSeen?.[flagKey] ??
    store.activity
      .filter((a) => a.flag_key === flagKey && a.app === "web")
      .map((a) => a.day)
      .sort()[0];

  return {
    evaluatedCount,
    blockedCount,
    totalEvents: evaluatedCount + blockedCount,
    variationCounts,
    activity,
    evaluated,
    liveHits,
    evaluatingShare: liveHits.reduce((s, h) => s + h.session_share, 0),
    firstSeen,
    descendants: descendantsOf(flagKey, defs),
  };
}

export function runSafetyCheck(
  store: EvidenceStore,
  params: SafetyCheckParams,
): SafetyCheckResult {
  const cfg = resolveParams(params);
  const defs = latestDefs(store, cfg.environment);
  const def = defs.get(params.flag_key);
  const baseEvidence: Record<string, unknown> = {
    window_days: cfg.window_days,
    min_session_share: cfg.min_session_share,
    min_events_for_settled: cfg.min_events_for_settled,
    min_events_floor: cfg.min_events_floor,
  };

  if (!def) {
    return buildVerdict(
      params.flag_key,
      undefined,
      "blocked",
      "none",
      `Flag ${params.flag_key} is no longer in the project definitions snapshot, so there is nothing to remove.`,
      baseEvidence,
      "none",
    );
  }

  const win = aggregateWindow(store, params.flag_key, cfg, defs);
  baseEvidence.rollout_percentage = def.rollout_percentage;
  baseEvidence.deprecated = def.deprecated;
  baseEvidence.archived = def.archived;
  baseEvidence.parent_key = def.parent_key;
  baseEvidence.evaluated_events = win.evaluatedCount;
  baseEvidence.blocked_events = win.blockedCount;
  baseEvidence.variation_counts = Object.fromEntries(win.variationCounts);
  baseEvidence.descendants = win.descendants;
  baseEvidence.live_build_hits = win.liveHits;
  baseEvidence.first_seen = win.firstSeen;
  baseEvidence.datafile_revision = def.datafile_revision;

  const parentGated =
    Boolean(def.parent_key) &&
    win.blockedCount > 0 &&
    win.evaluatedCount === 0;

  if (parentGated) {
    return buildVerdict(
      params.flag_key,
      def,
      "inconclusive",
      "abandoned",
      `Flag ${params.flag_key} was never evaluated in the window because parent ${def.parent_key} gated every lookup (${win.blockedCount} blocked_by_parent events). Absence of evaluations is not evidence of disuse.`,
      baseEvidence,
    );
  }

  if (win.descendants.length > 0) {
    return buildVerdict(
      params.flag_key,
      def,
      "blocked",
      def.deprecated || def.archived ? "lifecycle" : "abandoned",
      `Flag ${params.flag_key} still has living descendants (${win.descendants.join(", ")}). Removal must proceed bottom up.`,
      baseEvidence,
    );
  }

  if (
    !def.target_value &&
    (def.variation_count > 1 || win.evaluatedCount >= cfg.min_events_floor)
  ) {
    return buildVerdict(
      params.flag_key,
      def,
      "blocked",
      def.deprecated || def.archived ? "lifecycle" : "settled",
      `Flag ${params.flag_key} is mid-ramp at ${def.rollout_percentage}% (or multi-variation) with no single target_value, so the code cannot be collapsed safely.`,
      baseEvidence,
      "none",
    );
  }

  const settledShape =
    win.evaluatedCount >= cfg.min_events_for_settled &&
    win.variationCounts.size === 1 &&
    (def.rollout_percentage === 0 || def.rollout_percentage === 100) &&
    win.evaluatingShare >= 0.5;

  // Evidence before lifecycle: deprecation is a request, not permission.
  if (
    win.evaluatedCount > 0 &&
    win.liveHits.length > 0 &&
    win.evaluatingShare < 0.5
  ) {
    const hit = [...win.liveHits].sort(
      (a, b) => b.session_share - a.session_share,
    )[0]!;
    const share = win.evaluatingShare.toFixed(3);
    const reason =
      def.deprecated === 1 || def.archived === 1
        ? `Featurevisor marks ${params.flag_key} as ${def.deprecated ? "deprecated" : "archived"}, but it is still evaluated by a live minority build cohort (evaluating_share=${share}). Deprecation is a request; the evidence does not yet permit removal.`
        : `Flag ${params.flag_key} is still evaluated by live build ${hit.build_id} (released ${hit.released_at}, session_share=${hit.session_share.toFixed(3)}, evaluating_share=${share}).`;
    return buildVerdict(
      params.flag_key,
      def,
      "blocked",
      "abandoned",
      reason,
      baseEvidence,
    );
  }

  if (win.totalEvents > 0 && win.totalEvents < cfg.min_events_floor) {
    return buildVerdict(
      params.flag_key,
      def,
      "inconclusive",
      "abandoned",
      `Flag ${params.flag_key} has only ${win.totalEvents} events in the ${cfg.window_days}-day window, which is too thin to support a removal decision.`,
      baseEvidence,
    );
  }

  if (
    win.firstSeen &&
    new Date(`${win.firstSeen}T00:00:00Z`) >= cfg.windowStart
  ) {
    return buildVerdict(
      params.flag_key,
      def,
      "inconclusive",
      "abandoned",
      `Flag ${params.flag_key} first appeared on ${win.firstSeen}, inside the ${cfg.window_days}-day window, so the quiet period is incomplete.`,
      baseEvidence,
    );
  }

  if (win.evaluatedCount > 0 && win.evaluatedCount < cfg.min_events_floor) {
    return buildVerdict(
      params.flag_key,
      def,
      "inconclusive",
      "abandoned",
      `Flag ${params.flag_key} has only ${win.evaluatedCount} evaluated events in the ${cfg.window_days}-day window, which is too thin to support a removal decision.`,
      baseEvidence,
    );
  }

  if (def.deprecated === 1 || def.archived === 1) {
    if (!def.target_value) {
      return buildVerdict(
        params.flag_key,
        def,
        "blocked",
        "lifecycle",
        `Flag ${params.flag_key} is marked for removal but has no single target_value to collapse to.`,
        baseEvidence,
        "none",
      );
    }
    const collapse = collapseDirectionFromTarget(def.target_value);
    return buildVerdict(
      params.flag_key,
      def,
      "safe_to_remove",
      "lifecycle",
      `Featurevisor marked ${params.flag_key} as ${def.deprecated ? "deprecated" : "archived"}, structural checks passed, and target_value=${def.target_value} supports collapse_direction=${collapse}.`,
      baseEvidence,
    );
  }

  if (win.evaluatedCount === 0) {
    const collapse = collapseDirectionFromTarget(def.target_value);
    return buildVerdict(
      params.flag_key,
      def,
      "safe_to_remove",
      "abandoned",
      `Flag ${params.flag_key} had zero evaluated events in the last ${cfg.window_days} days, no live-build hits, and target_value=${def.target_value} supports ${collapse}.`,
      baseEvidence,
    );
  }

  if (settledShape) {
    const only = [...win.variationCounts.keys()][0];
    const collapse = collapseDirectionFromTarget(def.target_value);
    return buildVerdict(
      params.flag_key,
      def,
      "safe_to_remove",
      "settled",
      `Flag ${params.flag_key} is settled: ${win.evaluatedCount} evaluations in ${cfg.window_days} days all returned variation=${only}, rollout=${def.rollout_percentage}%, collapse=${collapse}.`,
      baseEvidence,
    );
  }

  return buildVerdict(
    params.flag_key,
    def,
    "inconclusive",
    "none",
    `Flag ${params.flag_key} did not qualify as abandoned or settled under current thresholds.`,
    baseEvidence,
  );
}

export function listCandidates(
  store: EvidenceStore,
  opts?: {
    window_days?: number;
    environment?: string;
    min_events_for_settled?: number;
    now?: Date;
  },
): Array<{
  flag_key: string;
  route: Route;
  evaluated_events: number;
  blocked_events: number;
  distinct_variations: number;
  parent_key: string;
  descendant_count: number;
  datafile_revision?: string;
}> {
  const cfg = resolveParams(opts);
  const defs = latestDefs(store, cfg.environment);
  const out = [];
  for (const def of defs.values()) {
    if (def.archived === 1) continue;
    const win = aggregateWindow(store, def.flag_key, cfg, defs);
    const lifecycle = def.deprecated === 1 || def.archived === 1;
    const settled =
      win.evaluatedCount >= cfg.min_events_for_settled &&
      win.variationCounts.size === 1 &&
      (def.rollout_percentage === 0 || def.rollout_percentage === 100);
    const midRamp =
      def.variation_count > 1 &&
      def.rollout_percentage > 0 &&
      def.rollout_percentage < 100;
    const route = (
      lifecycle ? "lifecycle" : settled || midRamp ? "settled" : "abandoned"
    ) as Route;
    out.push({
      flag_key: def.flag_key,
      route,
      evaluated_events: win.evaluatedCount,
      blocked_events: win.blockedCount,
      distinct_variations: win.variationCounts.size,
      parent_key: def.parent_key,
      descendant_count: win.descendants.length,
      datafile_revision: def.datafile_revision,
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
