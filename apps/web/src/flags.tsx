import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createFlagClient, type FlagClient } from "@stale-flags/flag-client";

type FlagContextValue = {
  client: FlagClient | null;
  loading: boolean;
  error: string | null;
};

const FlagContext = createContext<FlagContextValue>({
  client: null,
  loading: true,
  error: null,
});

export function FlagProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<FlagClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const datafileUrl = import.meta.env.VITE_DATAFILE_URL as string | undefined;
    if (!datafileUrl) {
      setError("VITE_DATAFILE_URL is not set");
      setLoading(false);
      return;
    }

    createFlagClient({
      datafileUrl,
      buildId: (import.meta.env.VITE_BUILD_ID as string) || "dev.local",
      eventsUrl: import.meta.env.VITE_TINYBIRD_API_HOST as string | undefined,
      eventsToken: import.meta.env.VITE_TINYBIRD_APPEND_TOKEN as string | undefined,
      flushIntervalMs: Number(import.meta.env.VITE_EVENT_FLUSH_MS ?? 2000),
      batchSize: Number(import.meta.env.VITE_EVENT_BATCH_SIZE ?? 20),
    })
      .then((c) => {
        if (!alive) return;
        setClient(c);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!alive) return;
        setError(err.message);
        setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo(
    () => ({ client, loading, error }),
    [client, loading, error],
  );

  return <FlagContext.Provider value={value}>{children}</FlagContext.Provider>;
}

export function useFlags(): FlagContextValue {
  return useContext(FlagContext);
}

export function useFlag(flagKey: string): {
  enabled: boolean;
  variation: string | null;
  ready: boolean;
  outcome: "evaluated" | "blocked_by_parent" | "pending";
  blockedBy: string;
} {
  const { client, loading } = useFlags();
  return useMemo(() => {
    if (!client || loading) {
      return {
        enabled: false,
        variation: null,
        ready: false,
        outcome: "pending" as const,
        blockedBy: "",
      };
    }
    const result = client.evaluate(flagKey);
    return {
      enabled: result.enabled,
      variation: result.variation,
      ready: true,
      outcome: result.outcome,
      blockedBy: result.blockedBy,
    };
  }, [client, loading, flagKey]);
}
