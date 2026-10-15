/** Ignore metadata that alone must never authorize a cleanup PR. */
export function isMetadataOnlyPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  if (p === "featurevisor/.featurevisor/REVISION") return true;
  if (/^featurevisor\/\.featurevisor\/existing-state-.*\.json$/.test(p)) {
    return true;
  }
  return false;
}

/**
 * Sixth gate: every flag must delete its Featurevisor YAML and the batch must
 * touch apps/ or packages/. REVISION / existing-state alone never pass.
 */
export function checkDiffSubstance(
  flagKeys: string[],
  dirtyPaths: string[],
): { ok: true } | { ok: false; flag: string; detail: string } {
  const paths = dirtyPaths.map((p) => p.replace(/\\/g, "/"));
  const hasAppOrPkg = paths.some(
    (p) =>
      !isMetadataOnlyPath(p) &&
      (p.startsWith("apps/") || p.startsWith("packages/")),
  );

  for (const key of flagKeys) {
    const yml = `featurevisor/features/${key}.yml`;
    if (!paths.includes(yml)) {
      return {
        ok: false,
        flag: key,
        detail: `missing deletion of ${yml}`,
      };
    }
    if (!hasAppOrPkg) {
      return {
        ok: false,
        flag: key,
        detail:
          "no apps/ or packages/ change (REVISION / existing-state alone are insufficient)",
      };
    }
  }
  return { ok: true };
}

export const GATES_LINE =
  "tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist, diff substance";
