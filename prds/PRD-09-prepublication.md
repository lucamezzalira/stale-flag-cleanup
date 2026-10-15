# PRD-09: Pre-publication Fixes and Housekeeping

The article goes live on 26 October and links to this repository.

## 1. Diff substance gate

Sixth surgeon gate (after tsc / vite / featurevisor / flag-key grep / security allowlist,
before `ensurePr`): every flag in the plan must delete `featurevisor/features/<flag>.yml`
and must have an `apps/` or `packages/` change that names that flag (not a batch-level
proxy). `REVISION` and `existing-state-*.json` alone never pass. Failure: rewind, no PR,
log `gate=diff_substance status=fail flag=<key>`, write `failed` to `cleanup_decision_log`.
Listed on the PR body `Gates:` line. (Per-flag naming tightened after PRD-10.)

## 2. Live shop evaluations (`listing_outlet_banner`)

**Finding (PRD-09):** the CloudFront shop at investigation time did **not** send events to
Tinybird (empty Vite Tinybird env). Synthetic `listing_outlet_banner` activity was
pre-window only, so abandoned was correct for seed. Flag removed in PR #14.

**Now (PRD-10+):** shop ships scoped `browser_events`; agent eligibility is still seed-driven.
See `docs/captures/article-2026-10/listing-outlet-investigation.md`.

FlagCallout `off · evaluated` means the Featurevisor SDK evaluated the flag and returned
false on the page. It is not proof of a Tinybird ingest.

**Choice taken:** document in `README.md`; do not claim live shop streaming drove removals.

## 3. Housekeeping

- PR #14 merged; #13 and #10 closed with comments; `demo` merged into `main`.
- Docs: Fargate host (not CodeBuild), REST/MCP protocol table, token scopes, decision log.

## 4. Captures

Under `docs/captures/article-2026-10/` after #14: PR files diff, shop after publish,
Listing with winter ribbon still on, datafile keys without the removed flags.
