# PRD-08: Honest Metrics and Evidence Before Lifecycle

Supersedes earlier PRD-08 drafts. The claim that PR #11 removed a flag still used by a
5% minority of sessions was wrong: `evaluating_share` was a summed metric misread as a
percentage (Problem 1). Lifecycle short-circuits (Problem 2) and lifecycle-only fixtures
(Problem 3) remain in scope.

## Problem 1: `evaluating_share` must be a share

`live_hits` previously took `max(session_share)` per build across the window and
`live_summary` summed those values. For flags evaluated on every build the sum exceeded 1
(for example 5.16). Verdict thresholds still worked; evidence narratives did not.

**Fix:** `evaluating_share` is the sum of each evaluating build's `session_share` on the
**most recent** `build_adoption` snapshot date. Result is a fraction in `[0, 1]`.
Harness passes `evaluating_share_pct` (for example `"96%"`) into the surgeon evidence
prompt; the model quotes that string.

## Problem 2: lifecycle after evidence

Verdict / route / reason order:

1. Missing definition → `blocked`
2. Parent-gated, zero evaluations → `inconclusive`
3. Living descendants → `blocked`
4. No single `target_value` → `blocked`
5. Thin evidence / first seen inside window → `inconclusive`
6. Live minority (`evaluating_share` < 0.5) → `blocked` (deprecation-aware reason)
7. Deprecated or archived → `safe_to_remove`, route `lifecycle`
8. Zero evaluations → `safe_to_remove`, route `abandoned`
9. Settled → `safe_to_remove`, route `settled`
10. Otherwise → `inconclusive`

## Problem 3: evidence-only removals

Fixtures (do not reuse removed keys):

| Flag | Expected |
|---|---|
| `listing_outlet_banner` | `safe_to_remove` / `abandoned` / `delete_gated_branch` |
| `checkout_secure_seal` | `safe_to_remove` / `settled` / `keep_gated_branch`, share in 0.5..1 |
| `nav_winter_ribbon` | `blocked` (deprecated + live minority) |

## Pitfalls

- Lifecycle markers made flags eligible before live traffic was checked.
- PR #11's evidence narrative misreported a summed metric as a percentage. Metrics exposed
  to models must mean what their names say.
