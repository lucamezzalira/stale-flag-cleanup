# Tinybird project

Datasources and pipes matching PRD-02. Deploy with the Tinybird CLI (`tb`) against your workspace.

Local development of the PoC uses `packages/verdicts` + `.local-data` seeded by `pnpm seed`, which implements the same ordered safety rules. When a Tinybird token is present, the generator also posts to these datasources.

## Deploy sketch

```bash
cd tinybird
tb login
tb deploy
```

Scope endpoint tokens to `flag_candidates`, `flag_safety_check`, and `cleanup_report` for MCP / agent use.

`flag_safety_check` takes query param `key` (the flag key). Activity nodes must qualify `flag_daily_activity.flag_key` (table alias). Selecting `{{ String(key) }} AS flag_key` next to an unqualified `WHERE flag_key = …` makes ClickHouse bind WHERE to the SELECT alias, so the filter always matches and event counts become workspace-wide.
