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

`flag_safety_check` takes query param `key` (the flag key). Do not name it `flag_key`: that collides with the column and turns `WHERE flag_key = …` into a tautology.
