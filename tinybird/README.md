# Tinybird project

Datasources and pipes matching PRD-02 / PRD-10. Deploy with the Tinybird CLI (`tb`)
against your workspace.

Local development uses `packages/verdicts` + `.local-data` seeded by `pnpm seed`, which
implements the same ordered safety rules. When scoped tokens are present, the generator
also posts to Tinybird.

## Deploy sketch

```bash
cd tinybird
tb login
tb --cloud deploy --wait
tb --cloud --show-tokens token ls
```

## Tokens (scoped writers)

Resource-scoped `TOKEN <name> APPEND|READ` declarations create these static tokens on
deploy. Copy values into `.env` / CI / Secrets Manager. **Never** put write tokens for
definitions, adoption, or decisions in the browser bundle.

| Token name | Env var | Can append / read | Used by | Where it lives |
|---|---|---|---|---|
| `browser_events` | `TINYBIRD_BROWSER_EVENTS_TOKEN` / `VITE_TINYBIRD_BROWSER_EVENTS_TOKEN` | APPEND `flag_evaluations`, `session_beacons` | Web app | Public shop bundle (by design) |
| `defs_publisher` | `TINYBIRD_DEFS_TOKEN` | APPEND `flag_definitions` | `tools/publish-defs` | GitHub Actions secret |
| `adoption_writer` | `TINYBIRD_ADOPTION_TOKEN` | APPEND `build_adoption` | Generator seed | Local `.env` (CI if used) |
| `decision_writer` | `TINYBIRD_DECISION_TOKEN` | APPEND `cleanup_decision_log` | Scout + surgeon | Secrets Manager `stale-flags/agent` |
| `endpoint_read` | `TINYBIRD_TOKEN` | READ pipes | Scout + surgeon harness | Secrets Manager |
| `surgeon_mcp_evidence` | `TINYBIRD_MCP_TOKEN` | READ `flag_safety_check`, `cleanup_report` | Surgeon evidence Converse | Secrets Manager (surgeon only) |

`flag_daily_activity` has **no** APPEND token. Only the materialised view
`flag_daily_activity_mv` writes to it. Seed expands daily aggregates into
`flag_evaluations` so the MV repopulates activity.

After changing token declarations, rotate any retired token (for example the old
`append_events`) with `tb --cloud token rm <name>` so leaked values stop working.

### Decision log

`cleanup_decision_log` records scout plans and surgeon outcomes (including gate failures
such as `diff_substance`). Append with `TINYBIRD_DECISION_TOKEN` only.

`flag_safety_check` takes query param `key` (the flag key). Activity nodes must qualify
`flag_daily_activity.flag_key` (table alias). Selecting `{{ String(key) }} AS flag_key`
next to an unqualified `WHERE flag_key = …` makes ClickHouse bind WHERE to the SELECT
alias, so the filter always matches and event counts become workspace-wide.

### Sorting key

`flag_daily_activity` uses `ENGINE_SORTING_KEY "flag_key, day, app, build_id, outcome,
variation"` because every safety query filters by `flag_key` first.

## Verdict cascade (authoritative copy)

**Authoritative:** `tinybird/pipes/flag_safety_check.pipe` (and `cleanup_report.pipe`,
which adds the “not in definitions” rule for the full matrix).

**Mirror:** `packages/verdicts` for local/offline scout and tests. CI
`verdict-parity` fails if pipe and TypeScript disagree on `verdict`, `route`, `reason`,
or `collapse_direction`.

Order in `multiIf` / TypeScript:

1. Missing definition → `blocked`
2. Parent-gated, zero evaluations → `inconclusive`
3. Living descendants → `blocked`
4. No single `target_value` (mid-ramp / multi-variation) → `blocked`
5. Thin evidence / first seen inside window → `inconclusive`
6. Live minority builds (`evaluating_share` &lt; 0.5) → `blocked` (reason mentions deprecation when set)
7. Deprecated or archived (after evidence passed) → `safe_to_remove`, route `lifecycle`
8. Zero evaluations → `safe_to_remove`, route `abandoned`
9. Settled (single variation, rollout 0/100, enough events, share ≥ 0.5) → `safe_to_remove`, route `settled`
10. Otherwise → `inconclusive`

### `evaluating_share`

Fraction in `[0, 1]`: sum of each evaluating build's `session_share` on the **most recent**
`build_adoption` snapshot date (not `max` across the window). A value above 1 is a bug.
