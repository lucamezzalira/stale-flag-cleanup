# Manual QA Agent (stale-flag cleanup)

Cursor agent playbook. Run this after every `pnpm infra:agent-run` (or the midnight UTC Step Functions schedule). Produce a durable report canvas for the run at:

`/Users/lucamezzalira/.cursor/projects/Users-lucamezzalira-Documents-tinybird/canvases/qa-run-<YYYYMMDD-HHMM>.canvas.tsx`

Do **not** merge PRs yourself. Stop at the merge gate and tell the human what to merge. After they confirm merge, continue with post-merge checks.

## Expected demo outcomes

| Flag | Verdict | Collapse | After merge (browser) |
|---|---|---|---|
| `promo_banner_2025` | `safe_to_remove` | `delete_gated_branch` | Banner / callout **gone** on Listing |
| `one_click_buy` | `safe_to_remove` | `keep_gated_branch` | One-click CTA **kept**, flag plumbing **gone** on Checkout |
| Other 6 flags | `blocked` / `inconclusive` | n/a | **No PR**; UI still shows those flags |

Web URL (CloudFront): from stack output `WebUrl` (currently `https://dj37uarwx2jpn.cloudfront.net`).
Datafile URL: `https://d1jcup3snfgsrs.cloudfront.net/featurevisor/production/featurevisor-all.json`.

## Phase 0. Start / identify the run

```bash
pnpm infra:agent-run
# capture executionArn, e.g. arn:aws:states:us-east-1:…:execution:stale-flags-cleanup:<uuid>
```

Record:

- `execution_arn` (and short execution name = last path segment)
- `started_at` (UTC)
- `BEDROCK_MODEL_ID` expected: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- Results bucket: stack output `AgentResultsBucketName`

## Phase 1. Step Functions / ECS / S3

```bash
aws stepfunctions describe-execution --region us-east-1 \
  --execution-arn "$EXECUTION_ARN" \
  --query '{status:status,start:startDate,stop:stopDate,error:error}'

# History (state names: Scout, LoadScoutResult, HasCandidates, RemoveFlags, NotifyMergeGate, …)
aws stepfunctions get-execution-history --region us-east-1 \
  --execution-arn "$EXECUTION_ARN" --max-items 50 \
  --query 'events[?type==`TaskStateEntered` || type==`TaskFailed` || type==`ExecutionSucceeded` || type==`ExecutionFailed`].[id,type,timestamp]' \
  --output table
```

ECS logs (log group created by CDK under the Agent construct; stream prefix `agent`):

```bash
aws logs describe-log-groups --region us-east-1 \
  --log-group-name-prefix /aws/ecs --query 'logGroups[*].logGroupName'

# Or find the task:
aws ecs list-tasks --cluster stale-flags-agent --region us-east-1
```

S3 handoff (execution name = `basename` of execution ARN):

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name StaleFlagsStack --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='AgentResultsBucketName'].OutputValue" --output text)
EXEC_NAME="${EXECUTION_ARN##*:}"
aws s3 cp "s3://$BUCKET/$EXEC_NAME/scout.json" - | jq '{run_id, candidates: [.candidates[].flag_key], skipped: [.skipped[].flag_key]}'
```

Pass criteria:

- Execution reaches `Succeeded` or `NothingToDo` (not `ScoutFailed`)
- Scout source is Tinybird (`source=tinybird-mcp` or REST fallback in ECS logs)
- `scout.json` has `candidates` for the two safe flags when evidence is seeded
- Surgeon uses Bedrock Sonnet 4.5 (or logs heuristic fallback only if Bedrock fails)
- No `pnpm seed` in the task

Fail criteria: execution `FAILED`, missing `rg`, git auth failure, Bedrock `AccessDenied` without successful heuristic fallback + PR, S3 object missing after Scout task exit 0.

## Phase 2. Tinybird evidence (pre-merge)

With `.env` loaded (`TINYBIRD_API_HOST`, `TINYBIRD_TOKEN`):

```bash
curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/cleanup_report.json" | jq '.data[] | {flag_key,verdict,route,collapse_direction}'

curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/flag_candidates.json" | jq '.data[] | {flag_key,route,last_verdict,last_pr_url,descendant_count}'

curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/flag_safety_check.json?flag_key=promo_banner_2025"
curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/flag_safety_check.json?flag_key=one_click_buy"
```

Pass criteria:

- Two safe flags with non-`none` collapse directions
- Six refusals still refuse
- If `last_pr_url` is set from a prior run and scout skips, truncate `cleanup_decision_log` / run `pnpm demo:reset` before re-demoing

## Phase 3. GitHub PRs (merge gate)

Expect up to two open PRs into `demo` (`agent/remove-promo_banner_2025`, `agent/remove-one_click_buy` or similar).

```bash
gh pr list --base demo --state open
```

SNS topic `stale-flags-merge-gate` should have received a notify message when candidates were processed (subscribe if you want email/SMS).

**Stop here.** Tell the human which PRs to merge. Do not merge.

## Phase 4. Post-merge (after human confirms)

1. Wait for `publish-flags.yml` on `demo` (or run `pnpm infra:sync`).
2. Hard-refresh the shop. Confirm Listing / Checkout UI expectations in the table above.
3. Confirm datafile no longer lists removed feature keys (or marks them absent).
4. Update the canvas with merge SHAs, GHA run URL, and browser results.

## Canvas report template

Title: `QA run <stamp>`

Sections:

1. Run identity (execution ARN, status, model)
2. Scout candidates vs Tinybird pipes
3. Surgeon outcomes (PR URLs, Bedrock vs heuristic)
4. Merge gate (waiting / merged)
5. Post-merge browser + CDN
6. Failures / follow-ups

## Common failure modes (SFN / ECS)

| Symptom | Likely cause | What to check |
|---|---|---|
| Scout task `CannotPullContainer` / exec format | Image arch ≠ task arch | Task is ARM64; rebuild image on matching arch or set `platform` |
| ScoutSucceeded but LoadScoutResult fails | Missing `scout.json` | RESULT_S3_URI write in scout; task role S3 put |
| ParseScoutResult fails | Body encoding | ASL should use `States.StringToJson($.scoutRaw.body)` only (CallAwsService Body is already UTF-8) |
| HasCandidates → NothingToDo | No safe flags / skip due to `last_pr_url` | Tinybird decision log; truncate if re-demo |
| Surgeon Map item → SurgeonFailed | Gates / Bedrock / git | ECS logs for that FLAG_KEY |
| Notify never fires | Choice took NothingToDo or Map empty | scout.json candidates |
| Public IP / timeout on clone | VPC egress | Public subnet + assignPublicIp; security groups |
| Old schedule still firing | Leftover CodeBuild schedule | Only `stale-flags-sfn-nightly-utc` should exist |
