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

`flag_safety_check` takes query param `key` (the flag key). Activity nodes must qualify `flag_daily_activity.flag_key` (table alias). Selecting `{{ String(key) }} AS flag_key` next to an unqualified `WHERE flag_key = …` makes ClickHouse bind WHERE to the SELECT alias, so the filter always matches and event counts become workspace-wide.
