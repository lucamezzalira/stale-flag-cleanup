# Tinybird project

Datasources and pipes matching PRD-02. Deploy with the Tinybird CLI (`tb`) against your workspace.

Local development of the PoC uses `packages/verdicts` + `.local-data` seeded by `pnpm seed`, which implements the same ordered safety rules. When a Tinybird token is present, the generator also posts to these datasources.

## Deploy sketch

```bash
cd tinybird
tb login
tb deploy
```

## Tokens (two roles)

| Env var | Protocol | Scope | Used by |
|---|---|---|---|
| `TINYBIRD_TOKEN` | REST | Read pipes the agent needs (`flag_candidates`, `cleanup_report`, `flag_safety_check`) plus any append scopes you already use for ingest | Scout, surgeon harness re-verify |
| `TINYBIRD_APPEND_TOKEN` | REST Events API | Append to datasources / decision log | Seed, publish-defs, decision append |
| `TINYBIRD_MCP_TOKEN` | MCP (`https://mcp.tinybird.co?token=…&host=…`) | **READ only** on `flag_safety_check` and `cleanup_report` (resource-scoped static token / JWT). Do **not** reuse `TINYBIRD_TOKEN`. | Surgeon evidence Converse call; humans in editors |

Resource-scoped MCP evidence token is declared in the pipes as `TOKEN surgeon_mcp_evidence READ` on `flag_safety_check.pipe` and `cleanup_report.pipe`. After `tb --cloud deploy`, copy that token into `.env` as `TINYBIRD_MCP_TOKEN` (`tb --cloud --show-tokens token ls`) and run `pnpm infra:secrets` so Secrets Manager `stale-flags/agent` has the key for the surgeon Fargate task only.

### Decision log

`cleanup_decision_log` records scout plans and surgeon outcomes (including gate failures such
as `diff_substance`). Append with `TINYBIRD_APPEND_TOKEN`. Scout writes planned rows; the
surgeon writes `safe_to_remove` on PR open or `failed` when a gate aborts before `ensurePr`.

`flag_safety_check` takes query param `key` (the flag key). Activity nodes must qualify `flag_daily_activity.flag_key` (table alias). Selecting `{{ String(key) }} AS flag_key` next to an unqualified `WHERE flag_key = …` makes ClickHouse bind WHERE to the SELECT alias, so the filter always matches and event counts become workspace-wide.

## Verdict cascade (PRD-08)

Order in `flag_safety_check` / `cleanup_report` `multiIf` (and `packages/verdicts`):

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

**Pitfalls:** Lifecycle markers made flags eligible before live traffic was checked.
PR #11's evidence narrative misreported a summed metric as a percentage. Metrics exposed to
models must mean what their names say.
