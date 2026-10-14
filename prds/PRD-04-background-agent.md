# PRD-04: Background Agent and Infrastructure

Depends on: PRD-02 endpoints returning real verdicts over PRD-03 data.

## Goal

A background agent that runs unattended, asks Tinybird which flags are safe to remove,
removes exactly those, and opens a pull request. Everything else it leaves alone, recording
why.

The agent must be developable locally with a fast loop, and deployable to AWS for the story
the article tells.

## Two components

### Scout

Deterministic code, not an LLM. It:

1. Calls `flag_candidates` to get the list.
2. Drops any candidate that already has an open pull request from a previous run, using
   `last_verdict` and `last_pr_url` from the endpoint. Without this the agent reopens the
   same pull request every night until the first one is merged.
3. Calls `flag_safety_check` for each remaining candidate.
4. Writes every verdict to `cleanup_decisions` with a shared `run_id`, whatever the outcome.
5. Dispatches one surgeon per `safe_to_remove` flag, passing the flag key, the reason, the
   `target_value`, the `collapse_direction` and the evidence.

The scout calls the Tinybird REST endpoints directly. It is deterministic code talking to a
REST API and there is no reason to put a protocol in between.

It must refuse to dispatch a surgeon for any verdict whose `collapse_direction` is `none`,
even if the verdict somehow says safe. That is a contradiction and the right response is to
stop and record it.

### Surgeon

An LLM agent, one per approved flag, each with its own working copy of the repository. It:

1. Re-verifies the verdict by calling `flag_safety_check` through the Tinybird MCP server
   before touching anything. If the verdict or the collapse direction has changed since the
   scout ran, it stops.
2. Removes the flag from the Featurevisor project: the feature YAML and its test spec.
3. Removes the flag from the application code, collapsing the conditional in the direction
   the endpoint gave it. `keep_gated_branch` means the gated code stays and the fallback
   goes. `delete_gated_branch` means the opposite. The surgeon never decides this and never
   infers it from the code.
4. Runs the validation gates.
5. Opens a pull request with the reason and the evidence in the description.

The two consumers are deliberate and worth preserving: the scout reaches the governed
questions over REST, the surgeon reaches the same questions over MCP. One surface, two kinds
of caller.

## Validation gates

All five must pass locally before a pull request is opened. No test suite.

1. `tsc --noEmit` across the workspace
2. `vite build` succeeds for the web app
3. `featurevisor lint` passes, proving the YAML is still valid after the definition is gone
4. A grep proving no reference to the flag key survives anywhere in `apps/`, `packages/` or
   `featurevisor/`
5. A diff guard confirming only expected paths were touched, and that nothing under
   `tinybird/`, `agent/`, `infra/` or `tools/` was modified

Gates three and four together are the interesting pair, because they prove the agent removed
the flag from both the configuration and the code rather than one of them. A flag deleted
from YAML but still referenced in a component is a broken build, and the reverse is silent
dead configuration.

If any gate fails, the surgeon may diagnose and retry within a bounded number of attempts.
If it still fails, it discards the working copy, opens no pull request, and records a
`failed` row in `cleanup_decisions`.

## Pull request contents

- Title naming the flag
- Body containing the verdict, the reason sentence from the endpoint, the collapse direction
  and target value it acted on, the evidence numbers, the window and thresholds used, and
  the `run_id`
- A line stating which gates passed
- Never auto merged. The agent has no merge rights.

## Local development loop

This matters more than the deployment.

- `pnpm agent:scout --dry-run` prints every candidate, its route, verdict, reason and
  collapse direction, and the proposed action, touching nothing
- `pnpm agent:surgeon --flag <key> --dry-run` prints the diff it would make without writing
  to GitHub
- `pnpm agent:run` runs the full mechanism end to end locally against the same Tinybird
  endpoints
- `pnpm demo:reset` returns the demo to a clean state

Build and iterate locally. Deploy to AWS only once the mechanism works, otherwise every
iteration costs a deployment.

### Reset without rewriting history for everyone

The agent works on a long-lived `demo` branch, never on `main`, and `demo:reset` resets that
branch rather than force-pushing the default branch. Anyone who has cloned the repository
keeps a stable `main`, and the article links to `main`. Reset must:

1. Close any pull requests the agent opened and leave a short comment saying the demo was
   reset
2. Delete the agent's working branches
3. Reset `demo` to a tagged commit
4. Re-run the definitions publisher so `flag_definitions` reflects the restored project,
   otherwise the restored flags stay invisible to `flag_candidates`

Step four is easy to forget and breaks the next run in a confusing way.

## AWS deployment

Check the current AgentCore documentation before building this. The service has moved
quickly and the shapes below are intent rather than API detail.

- The surgeon runs on **AgentCore Runtime**. This is the part of the architecture the
  audience cares about, because hosting an agent that runs unattended is the practical
  question everyone has.
- The scout can run on Runtime alongside it or as plain compute. It is deterministic code,
  so if Runtime adds friction, run it as a scheduled Lambda. The article's claim is about
  hosting a background agent, not about the orchestration being agentic end to end.
- **EventBridge Scheduler** invokes the scout nightly at midnight UTC. The same entry point
  must accept a direct invoke, so the schedule is the story and the direct call is the
  development loop.
- **AgentCore Identity** supplies credentials, referencing existing Secrets Manager secret
  ARNs rather than holding secrets itself.
- **AgentCore Gateway is not used.** Tinybird publishes its own MCP server and the scout
  uses plain HTTP, so Gateway would add a layer that contradicts the scoped Tinybird MCP
  connection the piece is about.

### Credentials

A fine grained GitHub token scoped to the single public demo repository with contents and
pull request write only, and no merge rights, held in Secrets Manager and reached through
Identity. The Tinybird token is scoped to the three endpoints and nothing else.

Both are worth a paragraph in the article, because a credential scoped to exactly what the
agent may touch is the same principle as a query surface scoped to exactly what it may ask.

## Out of scope

- Worktree isolation and parallel agents. Mention in the article as what you would add at
  scale, citing DoorDash. Do not build it.
- Retries across runs, queueing, or any backlog management
- Auto approval tiers or confidence scoring

## Acceptance criteria

- A dry run prints eight candidates with the verdicts from PRD-02 and proposes action on two
- A full run opens exactly two pull requests, for `promo_banner_2025` and `one_click_buy`
- The `promo_banner_2025` pull request deletes the gated branch, the `one_click_buy` pull
  request keeps it and removes the fallback, and neither direction was inferred from the code
- Both pull requests remove the flag from the YAML, the test spec and every call site, and
  pass all five gates
- `cleanup_decisions` contains eight rows for the run, one per candidate, with reasons
- The four refusals are legible to someone reading only `cleanup_decisions`
- Running the scout twice in a row opens no second pull request for a flag that already has
  one open
- After a merge and a definitions publish, the removed flag no longer appears as a candidate
- Deliberately breaking a gate causes no pull request to be opened and a `failed` row to be
  written
- `pnpm demo:reset` returns the repository, GitHub and `flag_definitions` to a clean state in
  one command, without touching `main`
