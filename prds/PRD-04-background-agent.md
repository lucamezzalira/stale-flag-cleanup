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

1. Calls Tinybird via **hosted MCP** (`call_endpoint` on `flag_candidates` +
   `cleanup_report`). Fargate sets `SCOUT_SOURCE=mcp`. REST is the fallback if MCP
   is unreachable.
2. Drops any candidate that already has `last_pr_url` from a previous run, so the agent
   does not reopen the same pull request every night until the first one is merged.
3. Plans only independently `safe_to_remove` rows with `collapse_direction != none`. It
   does not invent safety for parent-gated inconclusive children (wishlist nest honesty).
4. Writes every verdict to `cleanup_decision_log` with a shared `run_id`.
5. Writes `plan.json` to S3 (run id, branch name, candidates with payloads). Does **not**
   spawn surgeons in-process when running under Step Functions.

Optional among the planned set: leaf-first sort by `parent_key` edges. That only matters
when independently safe flags share a parent relationship. Wishlist does not qualify today.

### Surgeon

An LLM-backed editor (Bedrock Converse Sonnet 4.5, with heuristic fallback), **one Fargate
task for the whole plan**. It:

1. Loads the plan from `PLAN_S3_URI` / `--plan-s3`.
2. Before editing each flag, re-verifies live via **Tinybird MCP**
   `flag_safety_check?key=` (REST fallback; never `flag_key`). Aborts the whole plan
   (rewind, no PR) if live `verdict` / `collapse_direction` (and non-empty `target_value`)
   no longer match the plan payload, or if the request fails / returns empty. Dry-run
   still re-verifies.
3. For each planned flag, collapses Featurevisor YAML + app call sites using the pipe's
   `collapse_direction` / `target_value`. Never infers collapse from the code alone.
4. Runs validation gates per flag. All-or-nothing: if any flag fails, rewind local edits,
   write failure, and **do not** push or open a PR.
5. If every flag passes, push one branch and open **one** multi-flag pull request into
   `demo`. Never merges.

Single-flag `--flag=` mode remains for local dry runs.

## Validation gates

All five must pass locally before a pull request is opened. No test suite.

1. `tsc --noEmit` across the workspace
2. `vite build` succeeds for the web app
3. `featurevisor lint` / build proves the YAML is still valid after the definition is gone
4. A grep proving no reference to the flag key survives anywhere in `apps/`, `packages/` or
   `featurevisor/`
5. A diff guard confirming only expected paths were touched, and that nothing under
   `tinybird/`, `agent/`, `infra/` or `tools/` was modified. **REVISION-only diffs are a
   hard fail** for production QA.

If any gate fails after bounded Bedrock retries, discard the working tree edits for the
plan, open no pull request, and record `failed` rows.

## Pull request contents

- Title naming the planned flags (or a short multi-flag summary)
- Body containing per-flag verdict, reason, collapse direction, target value, evidence,
  window/thresholds, and `run_id`
- A line stating which gates passed
- Never auto merged. The agent has no merge rights. Merge gate = GitHub PR notifications +
  human review (no SNS topic).

## Local development loop

- `pnpm agent:scout --dry-run` prints every candidate, its route, verdict, reason and
  collapse direction, and the proposed action, touching nothing
- `pnpm agent:surgeon --flag <key> --dry-run` prints the diff it would make without writing
  to GitHub
- `pnpm demo:reset` returns the demo to a clean state (restore fixtures, truncate Tinybird)

Build and iterate locally. Deploy to AWS only once the mechanism works.

### Reset without rewriting history for everyone

The agent works on a long-lived `demo` branch, never on `main`, and `demo:reset` resets that
branch rather than force-pushing the default branch. Reset must:

1. Close any pull requests the agent opened and leave a short comment saying the demo was
   reset
2. Delete the agent's working branches
3. Reset `demo` to a tagged commit (restoring removable feature YAML + UI)
4. Truncate Tinybird demo tables and re-seed so `last_pr_url` cannot poison the next run
5. Re-publish definitions / datafile as needed **before** seed completes; do not
   `publish-defs` after seed in a way that races the window

## AWS deployment

Locked host for this PoC (not AgentCore, not CodeBuild as the agent host):

```text
EventBridge Scheduler (midnight UTC)
  → Step Functions (stale-flags-cleanup)
       → Scout Fargate (deterministic, no Bedrock IAM)
            → S3 plan.json
       → Choice (empty → NothingToDo)
       → Surgeon Fargate (one session, whole plan; Bedrock + git + gh)
            → push + one gh pr create only if all gates pass
       → Succeeded
```

- **Split images / IAM.** `Dockerfile.scout` vs `Dockerfile.surgeon`. Scout: secrets + S3.
  Surgeon: Bedrock Converse + git + `gh`. Pin image build `platform: LINUX_ARM64` to match
  Fargate task defs.
- **EventBridge Scheduler** starts the state machine nightly. `pnpm infra:agent-run` is the
  direct invoke for demos.
- **Secrets Manager** (`stale-flags/agent`) holds GitHub + Tinybird tokens. Written by
  `pnpm infra:secrets`, not clobbered on every CDK deploy.
- **S3 results bucket** holds per-execution `plan.json` and `surgeon-result.json`. Step
  Functions must treat GetObject Body as UTF-8 JSON (`StringToJson`), not Base64Decode.
- **No SNS.** No Map-per-flag fan-out for this product shape.

### Credentials

A fine-grained GitHub token scoped to the demo repository with contents and pull request
write only, and no merge rights. Tinybird tokens scoped for endpoint read / events append;
truncate needs an admin / `.tinyb` token.

## Out of scope

- AgentCore Runtime / Gateway
- Auto-merge
- Wishlist leaf → outer removal without seed redesign (children are inconclusive, not safe
  leaves)
- Worktree isolation and parallel surgeons at scale

## Acceptance criteria

- A dry run prints all candidates with pipe verdicts and proposes action only on
  independently `safe_to_remove` flags (`collapse_direction != none`)
- A full orchestrated run opens **one** pull request covering every planned safe flag
  (all-or-nothing). E2E fixtures use keys such as `loyalty_stamp_banner` /
  `express_pay_hint`, not a hardcoded classic-pair allowlist or `candidates.length === 2`
- Collapse direction comes from Tinybird, never inferred ad hoc in the surgeon
- Surgeon re-verifies each flag with `flag_safety_check?key=` immediately before edit;
  stale plan payloads abort with no PR
- The PR removes each planned flag from YAML, test spec, and call sites, and passes all
  five gates (REVISION-only = fail)
- `cleanup_decision_log` records every candidate for the run, including refusals
- Refusals (wishlist nest, mid-ramp, thin evidence, sticky build) stay readable from the
  log alone
- Re-running scout while `last_pr_url` is set opens no second PR for those flags
- After merge + publish (`pnpm infra:sync` or GHA), removed flags leave the datafile and
  the candidate set
- Gate failure opens no PR and writes `failed` rows (working tree rewound)
- `pnpm demo:reset` restores repo + Tinybird demo tables without touching `main`
