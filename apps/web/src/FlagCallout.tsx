type Props = {
  flagKey: string;
  enabled: boolean;
  variation: string | null;
  outcome: "evaluated" | "blocked_by_parent" | "pending";
  blockedBy?: string;
};

export function FlagCallout({
  flagKey,
  enabled,
  variation,
  outcome,
  blockedBy = "",
}: Props) {
  let stateClass = "state-off";
  let stateLabel = "off";
  if (outcome === "blocked_by_parent") {
    stateClass = "state-blocked";
    stateLabel = `blocked_by_parent → ${blockedBy || "?"}`;
  } else if (outcome === "pending") {
    stateLabel = "loading";
  } else if (enabled) {
    stateClass = "state-on";
    stateLabel = variation && variation !== "true" ? `on · ${variation}` : "on";
  } else if (variation && variation !== "false") {
    stateLabel = `off · ${variation}`;
  }

  return (
    <div className="flag-callout" aria-label={`Feature flag ${flagKey}`}>
      <span className="key">{flagKey}</span>
      {" · "}
      <span className={stateClass}>{stateLabel}</span>
      {" · "}
      {outcome}
    </div>
  );
}
