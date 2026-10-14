export type CollapseDirection = "keep_gated_branch" | "delete_gated_branch" | "none";

export interface TargetDerivationInput {
  rolloutPercentage: number;
  variationCount: number;
  /** Enabled / on value when a single variation applies at 100%. Defaults to "true". */
  enabledValue?: string;
  /** Disabled / off value when rollout is 0%. Defaults to "false". */
  disabledValue?: string;
}

/**
 * Derive the production target value and collapse direction.
 * Empty target_value means mid-ramp or multi-variation weight: no safe inline.
 */
export function deriveTargetValue(input: TargetDerivationInput): {
  targetValue: string;
  collapseDirection: CollapseDirection;
} {
  const enabledValue = input.enabledValue ?? "true";
  const disabledValue = input.disabledValue ?? "false";
  const { rolloutPercentage, variationCount } = input;

  if (rolloutPercentage > 0 && rolloutPercentage < 100) {
    return { targetValue: "", collapseDirection: "none" };
  }
  if (variationCount > 1) {
    return { targetValue: "", collapseDirection: "none" };
  }
  if (rolloutPercentage === 100) {
    return { targetValue: enabledValue, collapseDirection: "keep_gated_branch" };
  }
  if (rolloutPercentage === 0) {
    return { targetValue: disabledValue, collapseDirection: "delete_gated_branch" };
  }
  return { targetValue: "", collapseDirection: "none" };
}

export function collapseDirectionFromTarget(
  targetValue: string,
  enabledValue = "true",
  disabledValue = "false",
): CollapseDirection {
  if (!targetValue) return "none";
  if (targetValue === enabledValue) return "keep_gated_branch";
  if (targetValue === disabledValue) return "delete_gated_branch";
  // Single settled variation name counts as keep (enabled path)
  return "keep_gated_branch";
}

export function parentKeyFromRequired(
  requiredFeatures: unknown,
): string {
  if (!requiredFeatures) return "";
  if (typeof requiredFeatures === "string") return requiredFeatures;
  if (Array.isArray(requiredFeatures) && requiredFeatures.length > 0) {
    const first = requiredFeatures[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "feature" in first) {
      return String((first as { feature: string }).feature);
    }
    if (first && typeof first === "object" && "key" in first) {
      return String((first as { key: string }).key);
    }
  }
  return "";
}
