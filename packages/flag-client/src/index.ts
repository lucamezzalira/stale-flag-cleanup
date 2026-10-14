import { createFeaturevisor, type Featurevisor } from "@featurevisor/sdk";
import type { Context, DatafileContent } from "@featurevisor/types";

export type FlagOutcome = "evaluated" | "blocked_by_parent";

export interface FlagEvaluationEvent {
  timestamp: string;
  flag_key: string;
  outcome: FlagOutcome;
  variation: string;
  blocked_by: string;
  app: string;
  build_id: string;
  datafile_revision: string;
  user_hash: string;
  session_id: string;
}

export interface SessionBeaconEvent {
  timestamp: string;
  session_id: string;
  build_id: string;
  app: string;
}

export interface FlagClientOptions {
  datafileUrl: string;
  buildId?: string;
  app?: string;
  eventsUrl?: string;
  eventsToken?: string;
  flushIntervalMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
}

export interface FlagLookupResult {
  enabled: boolean;
  variation: string | null;
  outcome: FlagOutcome;
  blockedBy: string;
}

type DatafileFeature = {
  key?: string;
  requiredFeatures?: Array<string | { feature: string; enabled?: boolean }>;
  required?: Array<string | { key: string }>;
  variations?: Array<{ value: string }>;
};

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function hashUser(userId: string): string {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function featuresMap(
  datafile: DatafileContent,
): Record<string, DatafileFeature> {
  const features = datafile.features as
    | Record<string, DatafileFeature>
    | DatafileFeature[]
    | undefined;
  if (!features) return {};
  if (Array.isArray(features)) {
    const out: Record<string, DatafileFeature> = {};
    for (const f of features) {
      if (f.key) out[f.key] = f;
    }
    return out;
  }
  return features;
}

function parentKeys(feature: DatafileFeature | undefined): string[] {
  if (!feature) return [];
  const req = feature.requiredFeatures ?? feature.required;
  if (!req) return [];
  const list = Array.isArray(req) ? req : [req];
  return list.map((item) => {
    if (typeof item === "string") return item;
    if ("feature" in item) return item.feature;
    if ("key" in item) return item.key;
    return "";
  }).filter(Boolean);
}

export class FlagClient {
  private sdk: Featurevisor | null = null;
  private datafile: DatafileContent | null = null;
  private queue: object[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<
    Pick<
      FlagClientOptions,
      "buildId" | "app" | "flushIntervalMs" | "batchSize"
    >
  > &
    FlagClientOptions;
  private sessionId = randomId("sess");
  private userId = randomId("user");
  private ready = false;
  private initError: Error | null = null;

  constructor(options: FlagClientOptions) {
    this.opts = {
      buildId: options.buildId ?? "dev.local",
      app: options.app ?? "web",
      flushIntervalMs: options.flushIntervalMs ?? 2000,
      batchSize: options.batchSize ?? 20,
      ...options,
    };
  }

  get isReady(): boolean {
    return this.ready;
  }

  get error(): Error | null {
    return this.initError;
  }

  get revision(): string {
    return String(this.datafile?.revision ?? "");
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async init(): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.datafileUrl, { cache: "no-store" });
    if (!res.ok) {
      this.initError = new Error(
        `Failed to load datafile from ${this.opts.datafileUrl}: ${res.status}`,
      );
      throw this.initError;
    }
    this.datafile = (await res.json()) as DatafileContent;
    this.sdk = createFeaturevisor({ datafile: this.datafile });
    this.ready = true;
    this.startFlushLoop();
    this.enqueueBeacon();
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        void this.flush(true);
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void this.flush(true);
      });
    }
  }

  setUser(userId: string): void {
    this.userId = userId;
  }

  evaluate(flagKey: string, context?: Context): FlagLookupResult {
    if (!this.sdk || !this.datafile) {
      throw new Error("FlagClient not initialized");
    }
    const ctx: Context = { userId: this.userId, ...context };
    const feature = featuresMap(this.datafile)[flagKey];
    const parents = parentKeys(feature);

    for (const parent of parents) {
      const parentEnabled = this.sdk.isEnabled(parent, ctx);
      if (!parentEnabled) {
        const result: FlagLookupResult = {
          enabled: false,
          variation: null,
          outcome: "blocked_by_parent",
          blockedBy: parent,
        };
        this.enqueueEvaluation(flagKey, result);
        return result;
      }
    }

    const enabled = this.sdk.isEnabled(flagKey, ctx);
    const variation =
      this.sdk.getVariation(flagKey, ctx) ?? (enabled ? "true" : "false");
    const result: FlagLookupResult = {
      enabled,
      variation: String(variation),
      outcome: "evaluated",
      blockedBy: "",
    };
    this.enqueueEvaluation(flagKey, result);
    return result;
  }

  isEnabled(flagKey: string, context?: Context): boolean {
    return this.evaluate(flagKey, context).enabled;
  }

  getVariation(flagKey: string, context?: Context): string | null {
    return this.evaluate(flagKey, context).variation;
  }

  private enqueueEvaluation(flagKey: string, result: FlagLookupResult): void {
    const event: FlagEvaluationEvent = {
      timestamp: utcNow(),
      flag_key: flagKey,
      outcome: result.outcome,
      variation: result.variation ?? "",
      blocked_by: result.blockedBy,
      app: this.opts.app,
      build_id: this.opts.buildId,
      datafile_revision: this.revision,
      user_hash: hashUser(this.userId),
      session_id: this.sessionId,
    };
    this.queue.push(event);
    if (this.queue.length >= this.opts.batchSize) {
      void this.flush();
    }
  }

  private enqueueBeacon(): void {
    const event: SessionBeaconEvent = {
      timestamp: utcNow(),
      session_id: this.sessionId,
      build_id: this.opts.buildId,
      app: this.opts.app,
    };
    this.queue.push({ __kind: "session_beacon", ...event });
  }

  private startFlushLoop(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
  }

  async flush(useBeacon = false): Promise<void> {
    if (!this.opts.eventsUrl || !this.opts.eventsToken || this.queue.length === 0) {
      this.queue = [];
      return;
    }

    const batch = this.queue.splice(0, this.opts.batchSize * 5);
    const evaluations = batch.filter((e) => !("__kind" in (e as object)));
    const beacons = batch.filter(
      (e) => (e as { __kind?: string }).__kind === "session_beacon",
    );

    try {
      await Promise.all([
        this.postNdjson("flag_evaluations", evaluations, useBeacon),
        this.postNdjson(
          "session_beacons",
          beacons.map((b) => {
            const { __kind: _k, ...rest } = b as SessionBeaconEvent & {
              __kind: string;
            };
            return rest;
          }),
          useBeacon,
        ),
      ]);
    } catch {
      // Never break the app if the collector is unreachable.
    }
  }

  private async postNdjson(
    datasource: string,
    rows: object[],
    useBeacon: boolean, // maps to fetch keepalive
  ): Promise<void> {
    if (rows.length === 0 || !this.opts.eventsUrl || !this.opts.eventsToken) {
      return;
    }
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    const url = `${this.opts.eventsUrl.replace(/\/$/, "")}/v0/events?name=${datasource}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.eventsToken}`,
      "Content-Type": "application/x-ndjson",
    };

    await (this.opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers,
      body,
      keepalive: useBeacon,
    });
  }

  destroy(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    void this.flush(true);
  }
}

export async function createFlagClient(
  options: FlagClientOptions,
): Promise<FlagClient> {
  const client = new FlagClient(options);
  await client.init();
  return client;
}
