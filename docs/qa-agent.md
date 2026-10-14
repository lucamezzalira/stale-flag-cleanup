# Manual QA Agent (stale-flag cleanup)

Cursor agent playbook. Run this after every `pnpm infra:agent-run` (or scheduled CodeBuild). Produce a durable report canvas for the run at:

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
# capture build id, e.g. stale-flags-agent:<uuid>
```

Record:

- `build_id`
- `started_at` (UTC)
- `BEDROCK_MODEL_ID` expected: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`

## Phase 1. CodeBuild / CloudWatch

```bash
aws codebuild batch-get-builds --region us-east-1 \
  --ids "$BUILD_ID" \
  --query 'builds[0].{status:buildStatus,phase:currentPhase,start:startTime,end:endTime}'
```

When `SUCCEEDED` or `FAILED`, pull logs:

```bash
# Log group from stack: typically /aws/codebuild/stale-flags-agent
aws logs describe-log-streams --region us-east-1 \
  --log-group-name /aws/codebuild/stale-flags-agent \
  --order-by LastEventTime --descending --max-items 1

aws logs get-log-events --region us-east-1 \
  --log-group-name /aws/codebuild/stale-flags-agent \
  --log-stream-name "$STREAM" --limit 200
```

Pass criteria:

- Install has `ripgrep` + `gh`
- Scout source is Tinybird (`source=tinybird-mcp` or REST fallback)
- Surgeon uses Bedrock Sonnet 4.5 (or logs heuristic fallback only if Bedrock fails)
- No `pnpm seed` in the build

Fail criteria: build `FAILED`, missing `rg`, git auth failure, Bedrock `AccessDenied` without successful heuristic fallback + PR.

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

- `promo_banner_2025` + `one_click_buy` → `safe_to_remove`
- `wishlist` blocked with descendants including `wishlist_sharing` and `wishlist_sharing_qr`
- `wishlist_sharing` / `wishlist_sharing_qr` → `inconclusive` (parent-gated)
- `checkout_redesign` → `blocked` (sticky live build)
- `shipping_estimator` → `blocked` (mid-ramp)
- `search_ranking_v2` → `inconclusive` (thin evidence)
- After surgeon success, `cleanup_decision_log` / `flag_candidates.last_pr_url` populated for the two safe flags

Also confirm MCP path if used:

```bash
SCOUT_SOURCE=tinybird pnpm agent:scout -- --dry-run --tinybird
```

## Phase 3. GitHub PRs (code review)

```bash
gh pr list --repo lucamezzalira/stale-flag-cleanup --base demo \
  --json number,title,url,headRefName,state,files
```

For each agent PR (`agent/remove-<flag_key>`):

```bash
gh pr view <N> --repo lucamezzalira/stale-flag-cleanup --json title,body,files,commits,url
gh pr diff <N> --repo lucamezzalira/stale-flag-cleanup
```

Pass criteria per flag:

### `promo_banner_2025` (`delete_gated_branch`)

- Deletes `featurevisor/features/promo_banner_2025.yml` and its spec
- `Listing.tsx`: no `useFlag("promo_banner_2025")`, no `<FlagCallout flagKey="promo_banner_2025" />`, no promo banner UI
- Unused imports removed (`FlagCallout` / `useFlag` if no longer needed)
- Diff does **not** touch unrelated flags or `infra/` / `tinybird/` / `agent/`

### `one_click_buy` (`keep_gated_branch`)

- Deletes `featurevisor/features/one_click_buy.yml` and its spec
- `Checkout.tsx`: keeps One-click buy button; removes `useFlag("one_click_buy")` and its `FlagCallout`
- Leaves `checkout_redesign` and `shipping_estimator` intact

Fail criteria: leftover `rg` matches for the flag key in `apps` / `featurevisor` (except ignored datafiles), whole-file rewrites that delete sibling flags, PR open against `main`.

## Phase 4. Human merge gate (STOP)

Notify the human in chat + canvas with:

- PR URLs
- One-line summary of what each PR removes/keeps
- Explicit ask: **Please merge PR #N and PR #M into `demo`, then tell me when done.**

Do not merge, force-push, or close PRs unless the human asks.

## Phase 5. Post-merge automation

After the human confirms merges:

1. Wait for GitHub Actions `publish-flags` on `demo` (datafile S3 sync + CloudFront invalidation + optional `publish-defs`):

```bash
gh run list --repo lucamezzalira/stale-flag-cleanup --branch demo --workflow publish-flags.yml --limit 5
gh run watch <RUN_ID> --repo lucamezzalira/stale-flag-cleanup
```

If the workflow is not configured/secrets missing, fall back to local:

```bash
pnpm infra:sync
```

2. Wait ~60–90s for CloudFront datafile TTL / invalidation.

3. Re-check Tinybird:

```bash
# last_pr_url should still point at merged PRs; verdicts may stay safe_to_remove
# until the next scout run. Flag definitions should eventually reflect removal
# after publish-defs / seed policy for the demo.
curl -sS -H "Authorization: Bearer $TINYBIRD_TOKEN" \
  "$TINYBIRD_API_HOST/v0/pipes/flag_candidates.json" | jq .
```

## Phase 6. Browser verification

Use the Cursor browser tools against `WebUrl`:

1. Hard refresh Listing (`/`) and Checkout (`/checkout` or the app’s checkout route).
2. Confirm datafile no longer lists removed flags:

```bash
curl -sS "https://d1jcup3snfgsrs.cloudfront.net/featurevisor/production/featurevisor-all.json" \
  | jq '.features | keys'
```

Expected after successful publish of both removals:

- `promo_banner_2025` **absent** from datafile + Listing UI
- `one_click_buy` **absent** from datafile; Checkout still shows One-click buy CTA
- `checkout_redesign`, `shipping_estimator`, wishlist family **still present**

Screenshot Listing + Checkout and attach findings into the canvas (describe results; do not invent UI state).

## Phase 7. Write / update the run canvas

Create or update a canvas with embedded (no `fetch`) data:

- Run metadata (build id, status, model, timestamps)
- Tinybird verdict table (all 8 flags)
- Decision log / `last_pr_url` rows
- PR table (number, flag, collapse, review pass/fail, merge status)
- Post-merge automation status
- Browser / datafile checks
- Open human actions (merge needed / done)

Canvas path pattern:

`/Users/lucamezzalira/.cursor/projects/Users-lucamezzalira-Documents-tinybird/canvases/qa-run-<stamp>.canvas.tsx`

Link the canvas in the chat reply every time.

## Quick commands cheat sheet

```bash
# Start agent
pnpm infra:agent-run

# Local Tinybird scout dry-run
SCOUT_SOURCE=tinybird pnpm agent:scout -- --dry-run --tinybird

# Reset demo (closes agent PRs, truncates Tinybird, reseeds)
pnpm demo:reset

# Secrets / sync
pnpm infra:secrets
pnpm infra:sync
```

## Failure triage

| Symptom | Likely cause | Action |
|---|---|---|
| CodeBuild fails on `gh` / `rg` | install phase | Check buildspec apt/gh install |
| CodeBuild `Illegal option -o pipefail` | `/bin/sh` buildspec | Use `set -eu` only (no pipefail) |
| Scout skips both safe flags | stale `last_pr_url` in Tinybird | `pnpm demo:reset` or truncate `cleanup_decision_log` |
| Surgeon `AccessDenied` Bedrock | model entitlement | Confirm Sonnet 4.5 Converse; check `BEDROCK_MODEL_ID` |
| PR exists but Tinybird `last_pr_url` empty | append token / Events API | Check `TINYBIRD_APPEND_TOKEN` in Secrets Manager |
| Browser still shows removed flag | CDN cache / publish-flags not run | Invalidate CloudFront or `pnpm infra:sync` |
| `publish-flags` fails on pnpm/action-setup dual version | `version:` + `packageManager` both set | Drop `version:` from workflow; use packageManager only |
| Wishlist marked `safe_to_remove` | descendant SQL regression | Fail run; inspect `cleanup_report` reason |
