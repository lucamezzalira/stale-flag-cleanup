# Handoff: Tinybird MCP for Claude (and the article)

This doc is for Claude (or any editor agent) writing about **how Tinybird MCP fits the AWS agent path**. It is not a general repo tour. Read `prds/PRD-07-protocol-alignment.md` for the full product rule.

## The rule (memorize this)

> **Code talks to Tinybird over REST. Models and people talk to Tinybird over MCP.**
> **Every safety decision is taken by code, never by a model.**

If a draft says “the scout uses MCP” or “the LLM decides what is safe,” it is wrong for the current `demo` branch.

## Who calls what

| Caller | Protocol | Token | Decides safety? |
|---|---|---|---|
| Scout (Fargate, deterministic) | REST `GET /v0/pipes/{endpoint}.json` | `TINYBIRD_TOKEN` | No inventing. Plans only rows Tinybird already marks `safe_to_remove` |
| Surgeon harness `reverifyFlagSafety` | REST `flag_safety_check?key=` | `TINYBIRD_TOKEN` | **Yes.** Aborts the all-or-nothing PR on drift |
| Surgeon evidence Converse (after gates, before PR) | Tinybird MCP `call_endpoint` | `TINYBIRD_MCP_TOKEN` only | **No.** Writes narrative only |
| Surgeon edit Converse | No tools | — | Edits YAML/app under gates; cannot query Tinybird |
| Human in Cursor / Claude Desktop | Tinybird MCP | Scoped editor token | No |

## MCP surface (production)

- Hosted URL: `https://mcp.tinybird.co` with `token` + `host` query params (Streamable HTTP).
- Surgeon allowlist (harness-enforced): `flag_safety_check`, `cleanup_report`.
- Tinybird token name in pipes: `surgeon_mcp_evidence` (READ on those endpoints).
- Env / Secrets Manager key on the **surgeon task only**: `TINYBIRD_MCP_TOKEN`.
  Scout must never receive it. Do not put this key in CDK `generateSecretString`; set via `.env` + `pnpm infra:secrets`.

## PR body ownership (what the article should show)

Proven on [PR #11](https://github.com/lucamezzalira/stale-flag-cleanup/pull/11) (`run_20261015T120859`):

1. **Decision (harness)** — verdict, route, reason, collapse, `target_value`, `evaluated_events`, run id, gates. From REST re-verify. Model never supplies this.
2. **Evidence, retrieved via Tinybird MCP** — model narrative + footer with UTC timestamp and endpoint list.

If MCP is down / token revoked: PR still opens; narrative becomes “Evidence narrative unavailable for this run”; Decision is unchanged. Look for CloudWatch `mcp_evidence=unavailable`.

## Observability lines (CloudWatch)

Scout (`/scout`):

- `source=tinybird-rest` (never `tinybird-mcp`)
- `tinybird_rest endpoint=<name> status=<code> rows=<n>`

Surgeon (`/surgeon`):

- `tinybird_rest endpoint=flag_safety_check flag=<key> verdict=<v>`
- `tinybird_mcp tool=call_endpoint endpoint=<name> status=ok|error`
- `mcp_evidence=ok|unavailable tool_calls=<n>`

Acceptance cloud run for PRD-07: `41023cbe-7fbd-46f5-90f5-c40fd5aa3dd4`.
E2E with new fixtures (this handoff’s demo): `4541b483-55ad-4335-8300-dcaffbeaf809` → PR #11.

## What MCP is *not*

- Not the scout’s transport.
- Not how collapse direction is chosen (`collapse_direction` / `target_value` come from pipes).
- Not AgentCore Gateway (out of scope).
- Not a path for the editing model mid-edit (editing Converse has zero tools).

## Latest E2E fixtures (do not revive loyalty/express in the article)

| Flag | Collapse | BEFORE | AFTER |
|---|---|---|---|
| `size_guide_panel` | `delete_gated_branch` | Listing Size guide panel | Panel gone |
| `search_typo_suggest` | `keep_gated_branch` | Search “Did you mean…” + flag callout | Chip kept, `search_typo_suggest` plumbing gone |

Captures: `docs/captures/article-2026-10/16`–`20`. Shots 13–14 (Tinybird Cloud UI / SFN graph) skipped on purpose.

## Code pointers

- Scout REST: `agent/scout/src/index.ts`
- Surgeon re-verify + MCP evidence Converse: `agent/surgeon/src/index.ts`
- Fargate env: `infra/lib/agent-orchestrator.ts` (`SCOUT_SOURCE=tinybird`, surgeon secrets include `TINYBIRD_MCP_TOKEN`)
- Pipe tokens: `tinybird/pipes/flag_safety_check.pipe`, `cleanup_report.pipe`
- Product rule: `prds/PRD-07-protocol-alignment.md`

## Suggested article framing for Claude

1. Open with the protocol rule (REST for code / MCP for models).
2. Show scout CloudWatch REST lines, then surgeon REST re-verify abort power.
3. Show PR #11 body: Decision vs Evidence sections side by side.
4. Mention scoped `TINYBIRD_MCP_TOKEN` as the governed surface the model is allowed to touch.
5. Close with the UI before/after of `size_guide_panel` + `search_typo_suggest` so readers see delete_gated vs keep_gated without inventing safety in prose.
