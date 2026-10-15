/** Ignore metadata that alone must never authorize a cleanup PR. */
export function isMetadataOnlyPath(rel: string): boolean {
  const p = rel.replace(/\\/g, "/");
  if (p === "featurevisor/.featurevisor/REVISION") return true;
  if (/^featurevisor\/\.featurevisor\/existing-state-.*\.json$/.test(p)) {
    return true;
  }
  return false;
}

function normalize(rel: string): string {
  return rel.replace(/\\/g, "/");
}

/** True if unified diff shows a change under apps/ or packages/ that mentions the flag. */
export function flagTouchedInAppDiff(
  flagKey: string,
  unifiedDiff: string,
): boolean {
  if (!unifiedDiff) return false;
  const lines = unifiedDiff.split("\n");
  let inAppOrPkg = false;
  for (const line of lines) {
    const fileHit = /^diff --git a\/(.+?) b\//.exec(line);
    if (fileHit) {
      const path = normalize(fileHit[1]!);
      inAppOrPkg =
        (path.startsWith("apps/") || path.startsWith("packages/")) &&
        !isMetadataOnlyPath(path);
      continue;
    }
    if (!inAppOrPkg) continue;
    // Content change (not a hunk header) that names this flag.
    if (
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---") &&
      line.includes(flagKey)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sixth gate: every flag must delete its Featurevisor YAML and must have an
 * apps/ or packages/ change that names that flag (not a batch-level proxy).
 * REVISION / existing-state alone never pass.
 */
export function checkDiffSubstance(
  flagKeys: string[],
  dirtyPaths: string[],
  unifiedDiff = "",
): { ok: true } | { ok: false; flag: string; detail: string } {
  const paths = dirtyPaths.map(normalize);

  for (const key of flagKeys) {
    const yml = `featurevisor/features/${key}.yml`;
    if (!paths.includes(yml)) {
      return {
        ok: false,
        flag: key,
        detail: `missing deletion of ${yml}`,
      };
    }

    const pathMentionsFlag = paths.some(
      (p) =>
        !isMetadataOnlyPath(p) &&
        (p.startsWith("apps/") || p.startsWith("packages/")) &&
        p.includes(key),
    );
    const diffMentionsFlag = flagTouchedInAppDiff(key, unifiedDiff);
    if (!pathMentionsFlag && !diffMentionsFlag) {
      return {
        ok: false,
        flag: key,
        detail:
          `no apps/ or packages/ change naming ${key} (batch-level apps edits for other flags, or REVISION-only, are insufficient)`,
      };
    }
  }
  return { ok: true };
}

export const GATES_LINE =
  "tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist, diff substance";
