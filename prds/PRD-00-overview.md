# PRD-00: System Overview and Shared Contracts

## Purpose of this document

This is the root PRD. Every other PRD in this set assumes the contracts defined here.
Read this first, then the PRD for the component being built.

## What we are building

A proof of concept showing a background agent that removes stale feature flags from a
codebase, but only after consulting evidence that no single system holds on its own.

The argument the PoC has to demonstrate, in order:

1. The feature flag tool knows the flag definitions. It does not know whether a flag is
   still being used, because Featurevisor evaluates locally in memory from a datafile and
   no evaluation ever reaches a server.
2. The deployment pipeline knows which builds are live and how much traffic each one still
   serves. It knows nothing about flags.
3. Only by combining those signals can anything decide whether removing a flag is safe.
4. That combined evidence lives in Tinybird, and the questions an agent is allowed to ask
   are published as API Endpoints rather than exposed as database access.
5. The agent executes a verdict computed in SQL. It never reaches the verdict itself.

The most important outcomes of the PoC are the cases where the agent refuses to act.

## Two kinds of stale flag

A flag is worth removing for two quite different reasons, and a system that only catches one
of them misses the case most teams actually have.

**Abandoned.** Nobody evaluates it any more. The code path is dead. This is what the
dependency and build analysis is about.

**Settled.** It is evaluated constantly and always returns the same value, because it was
rolled out to everyone months ago and nobody went back to clean up. It is a constant
pretending to be a decision. This is the more common case in a real codebase, and catching
it needs no new data, only a second candidate rule over the `variation` column we already
collect.

Both routes feed the same safety check and produce the same verdicts.

## The eight demo flags

The synthetic dataset must produce all of the following outcomes on every run when the
Featurevisor fixtures for the two safes are present. These flag keys are referenced by
every other PRD.

| Flag key | Rollout | Route | Expected verdict | Why |
|---|---|---|---|---|
| `loyalty_stamp_banner` | 0% | lifecycle / abandoned | `safe_to_remove` | Deprecated, quiet in the window (or activity only before it). Collapses by deleting the gated branch |
| `express_pay_hint` | 100% | lifecycle / settled | `safe_to_remove` | Deprecated, heavy traffic all returning the same value. Collapses by keeping the gated branch |
| `checkout_redesign` | 100% | abandoned | `blocked` | Zero evaluations from any current build, but still evaluated several hundred times a day by an older build that retains a small share of live sessions |
| `shipping_estimator` | 60% | settled | `blocked` | Partial rollout abandoned mid-ramp. Traffic is split across two variations, so there is no single value to collapse to |
| `wishlist` | 0% | abandoned | `blocked` | Has living descendants that have not been removed yet |
| `wishlist_sharing` | 100% | abandoned | `inconclusive` | Zero real evaluations, but thousands of lookups short-circuited because the parent was off for the whole window |
| `wishlist_sharing_qr` | 100% | abandoned | `inconclusive` | Same as above, one level deeper |
| `search_ranking_v2` | 5% | abandoned | `inconclusive` | Sparse traffic, a handful of evaluations across the whole window, not enough evidence either way |

The agent may remove **any** independently `safe_to_remove` flag with
`collapse_direction != none`. There is no hardcoded allowlist of two keys. The pair above
(and historically `promo_banner_2025` / `one_click_buy` in early PRs) exists so delete vs
keep collapse both appear in one plan. After a successful cleanup those YAML keys leave
the project until restored for a re-demo.

## Why the nested case matters

A child flag gated behind a parent shows zero evaluations for a legitimate reason: the
parent was off, so the question was never asked. Absence of evaluations is not evidence of
absence of use. If the agent deletes the child and the parent is switched on next quarter,
the feature disappears silently with no error anywhere.

No amount of extra traffic data solves this, because the missing information is the
dependency graph, which lives in the flag definitions rather than in the telemetry. This is
the clearest demonstration of why the signals have to be combined.

## Why the target value matters

Knowing a flag is safe to remove is only half the decision. The agent also has to know what
to collapse the conditional to, and that value lives in the rollout state rather than in the
code. A flag at 0% collapses by deleting the gated branch. A flag at 100% collapses by
keeping it and deleting the fallback. A flag stuck at 60% has no correct answer and must be
refused.

An agent that infers the target from the code will eventually infer it wrong and silently
change behaviour, which is the single most dangerous failure this system can have. The
target value is therefore carried in `flag_definitions` and returned by the safety check. No
component is permitted to guess it.

## Time and timezone

Every window, every date boundary and every timestamp in this system is UTC. The generator
writes UTC, the endpoints compute in UTC, the agent schedule is UTC, and the CLI prints UTC
with the suffix shown. Do not use local time anywhere.

## Shared data contracts

All four Tinybird datasources are defined here because several components write to them.
PRD-02 owns their implementation.

### `flag_evaluations`

One row per flag lookup, emitted by the application.

| Column | Type | Notes |
|---|---|---|
| `timestamp` | DateTime | UTC, when the lookup happened |
| `flag_key` | String | Featurevisor feature key |
| `outcome` | LowCardinality(String) | `evaluated` or `blocked_by_parent` |
| `variation` | String | Resolved value when evaluated, empty when blocked |
| `blocked_by` | String | Parent flag key when blocked, empty otherwise |
| `app` | LowCardinality(String) | Always `web` in this PoC |
| `build_id` | String | Build that emitted the event, format `YYYY-MM-DD.<short-sha>` |
| `datafile_revision` | String | Featurevisor datafile revision in use |
| `user_hash` | String | Hashed user identifier |
| `session_id` | String | Session identifier |

Two columns carry more weight than the rest.

`outcome` is what makes the nested case decidable. A flag with zero `evaluated` rows and
many `blocked_by_parent` rows is obviously alive. A flag with neither is genuinely quiet.
Recording why a lookup happened, not only that it happened, is the whole point.

`variation` is what makes the settled case detectable. A flag where every row in the window
carries the same variation is a constant, however much traffic it sees.

### `build_adoption`

Periodic snapshot of which builds are still serving traffic.

| Column | Type | Notes |
|---|---|---|
| `snapshot_date` | Date | UTC |
| `app` | LowCardinality(String) | |
| `build_id` | String | |
| `released_at` | DateTime | UTC |
| `active_sessions` | UInt32 | |
| `session_share` | Float32 | 0 to 1, share of that day's sessions |

### `flag_definitions`

Published by CI from the Featurevisor project on every build. This is how the dependency
graph and the rollout state reach Tinybird.

| Column | Type | Notes |
|---|---|---|
| `captured_at` | DateTime | UTC |
| `datafile_revision` | String | |
| `flag_key` | String | |
| `parent_key` | String | From Featurevisor `requiredFeatures`, empty when none |
| `rollout_percentage` | UInt8 | 0 to 100 in the named environment |
| `target_value` | String | The value production currently serves, empty when the rollout is partial and no single value applies |
| `variation_count` | UInt8 | Number of variations defined, 1 for a plain boolean flag |
| `archived` | UInt8 | |
| `environment` | LowCardinality(String) | |

Only the most recent `captured_at` per flag is used when querying. A flag that disappears
from the project stops receiving new snapshots, which is how the system knows it is gone.

### `cleanup_decisions`

Written by the agent at the end of every run. This is the audit trail, not a results
dataset. It records what the evidence said at the moment a decision was taken.

| Column | Type | Notes |
|---|---|---|
| `decided_at` | DateTime | UTC |
| `run_id` | String | |
| `flag_key` | String | |
| `verdict` | LowCardinality(String) | `safe_to_remove`, `blocked`, `inconclusive`, `failed` |
| `reason` | String | Human readable, comes from the endpoint |
| `evidence` | String | JSON snapshot of what the safety check returned |
| `pr_url` | String | Empty unless a PR was opened |

## Repository layout

```
/apps/web               React CSR demo application
/packages/flag-client   Featurevisor SDK wrapper that emits evaluation events
/featurevisor           Featurevisor project (YAML definitions, tests)
/tinybird               Datasources, materialised views, endpoints
/tools/publish-defs     CI step publishing flag_definitions from the Featurevisor project
/tools/generator        Synthetic data generator and seeding
/tools/report           Local CLI report for humans without an MCP client
/tools/reset            Demo reset script
/agent/scout            Deterministic planner; Tinybird REST only (`SCOUT_SOURCE=tinybird`); writes S3 plan.json
/agent/surgeon          Bedrock editor + REST re-verify + MCP evidence narrative; one session per plan; one multi-flag PR
/infra                  CDK: EventBridge Scheduler, Step Functions, ECS Fargate (scout + surgeon images), Secrets Manager, S3/CloudFront
/docs                   These PRDs plus qa-agent playbook
README.md               Quickstart: clone, seed, run, see a refusal
```

TypeScript throughout. pnpm workspace. Public GitHub repository.

## Hard constraints

- No live vendor integrations. Featurevisor runs locally from the repo, all telemetry is
  synthetic. The article says so explicitly.
- No test suite in the demo application. Validation gates are listed in PRD-04 and are all
  deterministic checks rather than unit tests.
- No dashboard or UI for the analysis. The human surface is an API Endpoint consumed
  through MCP, plus a CLI report.
- The verdict is computed in SQL inside the Tinybird endpoint. No component outside
  Tinybird is permitted to decide whether a flag is safe to remove, or what value it
  collapses to.
- Scout does not invent safety (no scheduling parent-gated inconclusive children to unlock
  a parent). Merge gate is a human on GitHub. No SNS merge-gate topic. No auto-merge.
- AgentCore is out of scope for this PoC host. The agent runs on ECS Fargate.

## Verify before implementing

Tinybird's CLI and project file format have changed across versions. Do not assume the
syntax in these PRDs is current. Before writing any `.datasource` or `.pipe` file, check
the current format and CLI commands against the official documentation at docs.tinybird.co,
and follow that over anything written here. The schemas and the verdict logic in these PRDs
are the requirement. The exact file syntax is not.

The same applies to Featurevisor and to the AWS services in `/infra`: check current docs
for SDK and API shapes before coding against them.

## Build order

1. PRD-01 Demo application, instrumentation and the definitions publisher
2. PRD-02 Tinybird data layer
3. PRD-03 Synthetic data generator
4. PRD-05 Reporting, decision log and README
5. PRD-04 Background agent and infrastructure
6. PRD-06 Capture checklist, which runs alongside everything else rather than at the end

PRD-02 and PRD-03 are the critical path. The agent cannot be developed until the endpoints
return real verdicts over seeded data.
