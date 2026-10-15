# PRD-09: Pre-publication Fixes and Housekeeping

The article goes live on 26 October and links to this repository.

## 1. Diff substance gate

Sixth surgeon gate (after tsc / vite / featurevisor / flag-key grep / security allowlist,
before `ensurePr`): every flag in the plan must delete `featurevisor/features/<flag>.yml`
and the batch must change something under `apps/` or `packages/`. `REVISION` and
`existing-state-*.json` alone never pass. Failure: rewind, no PR, log
`gate=diff_substance status=fail flag=<key>`, write `failed` to `cleanup_decision_log`.
Listed on the PR body `Gates:` line.

## 2. Live shop evaluations (`listing_outlet_banner`)

**Finding:** the deployed CloudFront shop does **not** send events to Tinybird. The production
bundle bakes `eventsUrl:""` / `eventsToken:""`. Workspace `flag_evaluations` and
`session_beacons` are empty. `listing_outlet_banner` activity in Tinybird is seed-only
pre-window `flag_daily_activity` (zero in the 90-day window → abandoned was correct for
synthetic data).

FlagCallout `off · evaluated` means the Featurevisor SDK evaluated the flag and returned
false on the page. It is not proof of a Tinybird ingest.

**Choice taken:** document the gap in `README.md` (do not reclassify the abandoned fixture).
Correct any article sentence that claims the live shop streams evaluations into Tinybird.

## 3. Housekeeping

- PR #14 merged; #13 and #10 closed with comments; `demo` merged into `main`.
- Docs: Fargate host (not CodeBuild), REST/MCP protocol table, token scopes, decision log.

## 4. Captures

Under `docs/captures/article-2026-10/` after #14: PR files diff, shop after publish,
Listing with winter ribbon still on, datafile keys without the removed flags.
