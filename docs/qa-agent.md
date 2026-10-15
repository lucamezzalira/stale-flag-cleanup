# Manual QA Agent (stale-flag cleanup)

Production-bar playbook. After every `pnpm infra:agent-run`, write a canvas at:

`/Users/lucamezzalira/.cursor/projects/Users-lucamezzalira-Documents-tinybird/canvases/qa-run-<YYYYMMDD-HHMM>.canvas.tsx`

Do **not** merge PRs yourself. Do **not** treat REVISION-only diffs as success.

## E2E fixtures (must not hardcode the classic pair)

Current safe fixtures for a green demo:

| Flag | Collapse / verdict | BEFORE UI | AFTER UI |
|---|---|---|---|
| `catalog_clearance_rail` | abandoned / `delete_gated_branch` | Listing clearance (off at 0%) | Flag + panel plumbing **gone** |
| `checkout_trust_badges` | settled / `keep_gated_branch` | Checkout trust badges | Badges **kept**, flag plumbing **gone** |
| `nav_winter_ribbon` | **blocked** (deprecated + live minority) | Listing winter ribbon | **Still present** (must not be in PR) |

Refusals (still present, no PR): `wishlist` (+ children), `checkout_redesign`, `shipping_estimator`, `search_ranking_v2`, `nav_winter_ribbon`.

Assert by **key lists from scout `plan.json`**. PRD-08: deprecation does not override live
minority evidence.

Web URL: stack `WebUrl` (`https://dj37uarwx2jpn.cloudfront.net`).
Datafile: `https://d1jcup3snfgsrs.cloudfront.net/featurevisor/production/featurevisor-all.json`.

## Phase 0. Preflight

1. Close noop agent PRs (e.g. #7/#8 REVISION-only). Never merge them.
2. Ensure new flag YAML + UI are on `demo` and published.
3. Truncate `cleanup_decision_log` (admin / `pnpm seed` path); prove `last_pr_url` empty for target keys.
4. Order: code on demo → truncate → datafile/web publish → seed (do not `publish-defs` after seed).

```bash
pnpm infra:agent-run
# capture executionArn
```

## Phase 1. Step Functions / ECS / S3

```bash
aws stepfunctions describe-execution --region us-east-1 --execution-arn "$EXECUTION_ARN"
BUCKET=$(aws cloudformation describe-stacks --stack-name StaleFlagsStack --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='AgentResultsBucketName'].OutputValue" --output text)
EXEC_NAME="${EXECUTION_ARN##*:}"
aws s3 cp "s3://$BUCKET/$EXEC_NAME/plan.json" - | jq '{run_id, branch_name, candidates: [.candidates[].flag_key]}'
aws s3 cp "s3://$BUCKET/$EXEC_NAME/surgeon-result.json" - | jq .
```

Pass: SUCCEEDED; plan lists the **new** safe keys; surgeon-result `ok:true` with one `pr_url`.

## Phase 2. Tinybird

```bash
curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/cleanup_report.json" \
  | jq '.data[] | {flag_key,verdict,collapse_direction}'
```

## Phase 3. GitHub (merge gate)

Expect **one** PR into `demo` with YAML deletes + app diffs for every planned key.

```bash
gh pr view <N> --json files,url,baseRefName
gh pr diff <N> --name-only
```

**Fail** if diff ⊆ `featurevisor/.featurevisor/REVISION`. Stop for human merge.

## Phase 4. Post-merge

Publish (GHA or `pnpm infra:sync`). Record invalidation IDs. Hard-refresh shop + fetch datafile JSON. Confirm keys absent and UI collapses. Wishlist still refused.

## Expected observability logs (PRD-07)

Scout (CloudWatch `/scout`):

- `source=tinybird-rest` on the run banner (never `tinybird-mcp`)
- `tinybird_rest endpoint=<name> status=<code> rows=<n>`

Surgeon (CloudWatch `/surgeon`):

- `tinybird_rest endpoint=flag_safety_check flag=<key> verdict=<v>` before each edit
- `tinybird_mcp tool=call_endpoint endpoint=<name> status=ok|error` during evidence narrative
- `mcp_evidence=ok|unavailable tool_calls=<n>` before PR create
- Allowlist rejects: `tinybird_mcp allowlist_reject endpoint=<name>`

PR body must contain **Decision (harness)** from REST re-verify, plus **Evidence, retrieved via Tinybird MCP** (or the unavailable fallback line).

## Failure modes

| Symptom | Check |
|---|---|
| NothingToDo | `last_pr_url` poison; truncate decision log |
| REVISION-only PR | Already-removed flags; restore YAML/UI first |
| SurgeonFailed mid-plan | No remote push (all-or-nothing); ECS surgeon logs |
| CDN false green | Assert datafile JSON keys, not UI alone |
| Scout MCP logs | Bug: scout must be REST-only after PRD-07 |
| Decision section missing / model-owned | Bug: harness must own Decision from REST |
