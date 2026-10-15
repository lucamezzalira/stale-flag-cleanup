# PRD-07: Protocol Alignment, REST for Code and MCP for Models

## Why this change

The wiring was inverted relative to the architecture the article describes.

- Scout is deterministic code but previously called Tinybird through MCP with REST fallback. Deterministic components must not inherit non-determinism from transport.
- Surgeon's model (Bedrock Converse Sonnet 4.5) never talked to Tinybird. The article claims the agent reaches published endpoints via scoped Tinybird MCP.

Rule after this change:

> Code talks to Tinybird over REST. Models and people talk to Tinybird over MCP.
> Every safety decision is taken by code, never by a model.

| Caller | Protocol | Can it decide safety? |
|---|---|---|
| Scout | REST | No (reads pipe verdicts; plans only) |
| Surgeon harness (`reverifyFlagSafety`) | REST | Yes (abort on drift; Decision section) |
| Surgeon editing model | none | No |
| Surgeon evidence model | MCP | No (narrative only) |
| Humans / editors | MCP | No |

## Scope

1. **Scout: REST only** (`agent/scout`). No MCP client. `source=tinybird-rest`. Non-2xx hard-fails. `SCOUT_SOURCE=tinybird` on Fargate.
2. **Surgeon harness: REST re-verify** before each edit and in dry-run. Abort all-or-nothing PR on drift. Decision section from REST only.
3. **Surgeon model: read-only Tinybird MCP** for evidence narrative after gates, before `ensurePr`. Separate Converse with `tinybird_call_endpoint` allowlisted to `flag_safety_check` + `cleanup_report`. Editing Converse stays tool-free. `TINYBIRD_MCP_TOKEN` (not `TINYBIRD_TOKEN`) on surgeon task only.
4. **Observability** log lines for REST / MCP / summary (see `docs/qa-agent.md`).
5. **Docs** protocol rule, caller table, ECS Fargate host (not CodeBuild), Tinybird token README (two-token sketch; **superseded by PRD-10** scoped writers).

## Out of scope

- Tools on the editing model
- Model influencing verdict / plan / collapse
- AgentCore Gateway
- Changing pipes / verdict logic

## Acceptance

1. Scout has no MCP dep; logs `source=tinybird-rest`; broken token fails hard.
2. `reverifyFlagSafety` runs before every edit; aborts on drift.
3. Cloud run shows surgeon `tinybird_mcp` logs and no scout MCP logs.
4. PR body has Decision + Evidence sections when MCP works.
5. Without / revoked `TINYBIRD_MCP_TOKEN`: PR still opens with unavailable narrative.
6. Allowlist rejection logged.
7. Docs do not present CodeBuild as the agent host.
