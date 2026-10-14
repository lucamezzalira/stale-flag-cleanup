# Stale feature flag cleanup (PoC)

Background agent removes stale [Featurevisor](https://featurevisor.com) flags only after [Tinybird](https://www.tinybird.co)-shaped evidence says it is safe. Verdicts are computed by ordered rules (SQL endpoints in `tinybird/`, TypeScript mirror in `packages/verdicts` for local runs). The agent executes them. Refusals are the point of the demo.

All telemetry in this repository is **synthetic**. The generator is in `tools/generator`.

## Architecture

Signals in: flag evaluation events + session beacons (`build_id`), Featurevisor definition snapshots (including `deprecated` / `archived`), build adoption shares.

Questions out: `flag_candidates`, `flag_safety_check`, `cleanup_report`.

Agent on top: deterministic **scout** (REST / local store) writes `cleanup_decision_log` and dispatches **surgeon** (local Ollama for PR prose; deterministic code collapse). PRs target the `demo` branch only, never `main`.

## Prerequisites

- Node.js >= 24, pnpm 10+
- Optional: Tinybird token (cloud ingest), AWS (datafile CDN), GitHub token (real PRs)
- Optional for surgeon PR text: [Ollama](https://ollama.com) with `qwen3:8b` (or set `OLLAMA_MODEL`). Set `OLLAMA_DISABLED=1` to skip.

Copy `.env.example` to `.env` and adjust.

## Quickstart (clone → see a refusal)

```bash
pnpm install
pnpm datafile:build
pnpm datafile:serve   # terminal 1 — CDN stand-in
pnpm seed             # terminal 2 — 90-day synthetic history → .local-data/
pnpm publish-defs     # prints or posts flag_definitions
pnpm report           # table of eight flags + verdicts
pnpm agent:scout -- --dry-run
```

You should see `promo_banner_2025` and `one_click_buy` as `safe_to_remove` (Featurevisor `deprecated: true`), and refusals for `checkout_redesign`, `shipping_estimator`, `wishlist`, wishlist children, and `search_ranking_v2`.

Run the web app (with datafile server up):

```bash
export VITE_DATAFILE_URL=http://127.0.0.1:4099/production/featurevisor-all.json
pnpm dev
```

## MCP (Tinybird)

When the Tinybird project is deployed, scope a token to the three endpoints only and add the Tinybird MCP server in your editor. Ask which flags are queued tonight; answers should come from `cleanup_report` / `flag_safety_check` with sentence `reason` fields.

Local demos use `pnpm report` against `.local-data` (same verdict rules).

## Environment variables

See `.env.example`. Important ones:

| Var | Purpose |
|---|---|
| `VITE_DATAFILE_URL` | Remote Featurevisor datafile URL |
| `TINYBIRD_*` | Optional cloud ingest / API |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | Surgeon PR body generation |
| `GITHUB_TOKEN` / `DEMO_BRANCH` | Real PRs against `demo` |

## Agent commands

```bash
pnpm agent:scout -- --dry-run
pnpm agent:run          # writes cleanup_decision_log + dispatches surgeons
pnpm agent:surgeon -- --flag=promo_banner_2025 --dry-run
pnpm demo:reset         # reset demo branch tag + republish + reseed
```

## Repo layout

```
apps/web                 React + Vite demo shop
packages/flag-client     Featurevisor wrapper + event emission
packages/verdicts        Safety-check rules (local mirror of Tinybird intent)
packages/defs-utils      target_value / collapse_direction derivation
featurevisor             Flag YAML (promo + one_click are deprecated)
tinybird                 Datasources + pipes
tools/*                  seed, report, publish-defs, publish-datafile, reset
agent/scout|surgeon      Background agent
infra                    AWS notes (AgentCore later)
docs/capture-checklist.md
```
