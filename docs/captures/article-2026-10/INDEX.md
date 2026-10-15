# Article captures (2026-10-15)

Real browser / Terminal captures only. No invented HTML mock UIs.

| # | Shot | File | Source |
|---|---|---|---|
| 1 | promo delete gated (Listing.tsx) | `01-pr6-promo-listing-diff.png` | GitHub commit `c1b9dea` (PR #6) |
| 2 | one_click keep gated (Checkout.tsx) | `02-pr5-oneclick-checkout-diff.png` | GitHub commit `ace0e2a` (PR #5) |
| 3 | PR body verdict / evidence / run id | `03-pr5-body.png` | GitHub PR #5 conversation |
| 4 | Scout dry-run eight verdicts (MCP) | `04-scout-dry-run-eight.png` | Live `SCOUT_SOURCE=mcp` dry-run output |
| 5 | flag_safety_check checkout_redesign | `05-flag-safety-checkout.png` | Live Tinybird pipe JSON |
| 6 | Datafile keys BEFORE | `06-datafile-before-keys.png` | Feature keys at git `639c4be` |
| 7 | Datafile AFTER | `07-datafile-after-keys.png` | Live CloudFront `featurevisor-all.json` rev 12 |
| 8 | Listing BEFORE (promo banner on) | `08-listing-before.png` | Real pre-PR6 app build + datafile |
| 9 | Listing AFTER | `09-listing-after.png` | Live `https://dj37uarwx2jpn.cloudfront.net/` |
| 10 | Checkout AFTER one-click CTA | `10-checkout-after.png` | Live `/checkout` |
| 11 | cleanup_decision_log rows | `11-decision-log.png` | Tinybird MCP query `run_20261015T110706` |
| 12 | cleanup_report (MCP call_endpoint) | `12-mcp-queued.png` | Live Tinybird `cleanup_report` JSON |
| 13 | Tinybird endpoint + params | *(missing)* | Needs signed-in Tinybird Cloud |
| 14 | Green Step Functions graph | *(missing)* | Needs signed-in AWS console |
| 15 | PR body Decision (harness) + Evidence (MCP) | `15-pr10-body-decision-evidence.png` | GitHub PR #10 conversation |

## Still need you signed in

Shots 13 and 14 still need signed-in Tinybird Cloud + AWS console.

1. Tinybird Cloud: https://cloud.tinybird.co/aws/us-east-1/featureflags/pipes/flag_safety_check
2. AWS SFN (PRD-07 cloud run): https://us-east-1.console.aws.amazon.com/states/home?region=us-east-1#/v2/executions/details/arn:aws:states:us-east-1:661975750538:execution:stale-flags-cleanup:41023cbe-7fbd-46f5-90f5-c40fd5aa3dd4

Browser automation hit the login walls for both. Sign in in the Cursor browser tab and say go for 13–14.

Deep links:
- Live shop: https://dj37uarwx2jpn.cloudfront.net/
- Datafile: https://d1jcup3snfgsrs.cloudfront.net/featurevisor/production/featurevisor-all.json
- PR #10 (Decision + Evidence): https://github.com/lucamezzalira/stale-flag-cleanup/pull/10
- SFN execution `41023cbe-7fbd-46f5-90f5-c40fd5aa3dd4`: https://us-east-1.console.aws.amazon.com/states/home?region=us-east-1#/v2/executions/details/arn:aws:states:us-east-1:661975750538:execution:stale-flags-cleanup:41023cbe-7fbd-46f5-90f5-c40fd5aa3dd4
