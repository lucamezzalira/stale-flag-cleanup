# Article captures (2026-10-15)

Real browser captures only. Shots 13–14 (Tinybird Cloud UI / AWS SFN graph) skipped on purpose.

| # | Shot | File | Source |
|---|---|---|---|
| 1 | promo delete gated (Listing.tsx) | `01-pr6-promo-listing-diff.png` | GitHub commit `c1b9dea` (PR #6) |
| 2 | one_click keep gated (Checkout.tsx) | `02-pr5-oneclick-checkout-diff.png` | GitHub commit `ace0e2a` (PR #5) |
| 3 | PR body verdict / evidence / run id | `03-pr5-body.png` | GitHub PR #5 conversation |
| 4 | Scout dry-run eight verdicts | `04-scout-dry-run-eight.png` | Earlier scout dry-run |
| 5 | flag_safety_check checkout_redesign | `05-flag-safety-checkout.png` | Live Tinybird pipe JSON |
| 6 | Datafile keys BEFORE | `06-datafile-before-keys.png` | Feature keys at git `639c4be` |
| 7 | Datafile AFTER (rev 12 era) | `07-datafile-after-keys.png` | CloudFront datafile |
| 8 | Listing BEFORE (promo) | `08-listing-before.png` | Pre-PR6 app build |
| 9 | Listing AFTER promo | `09-listing-after.png` | Live shop |
| 10 | Checkout AFTER one-click | `10-checkout-after.png` | Live `/checkout` |
| 11 | cleanup_decision_log rows | `11-decision-log.png` | Tinybird query |
| 12 | cleanup_report JSON | `12-mcp-queued.png` | Tinybird `cleanup_report` |
| 13 | Tinybird endpoint UI | *(skipped)* | — |
| 14 | SFN execution graph | *(skipped)* | — |
| 15 | PR #10 Decision + Evidence | `15-pr10-body-decision-evidence.png` | GitHub PR #10 |
| 16 | Listing BEFORE size guide | `16-listing-before-size-guide.png` | Live shop, `size_guide_panel` on |
| 17 | Search BEFORE typo suggest | `17-search-before-typo-suggest.png` | Live shop, `search_typo_suggest` on |
| 18 | Listing AFTER size guide gone | `18-listing-after-size-guide-gone.png` | Live shop post PR #11 |
| 19 | Search AFTER tip kept | `19-search-after-typo-kept.png` | Live shop post PR #11 |
| 20 | PR #11 Decision + Evidence (MCP) | `20-pr11-body-decision-evidence.png` | GitHub PR #11 |
| 21 | PR #14 Files (keep vs delete) | `21-pr14-files-checkout-listing.png` | GitHub PR #14 diffs |
| 22 | Checkout after seal kept | `22-checkout-after-seal-kept.png` | Live shop post #14 |
| 23 | Listing winter ribbon still on | `23-listing-after-winter-still-on.png` | Live shop refusal UI |
| 24 | Datafile keys after publish | `24-datafile-keys-after-publish.json` (+ PNG when available) | CloudFront rev 24 |

PRD-08/09 extras: `latest/` and `listing-outlet-investigation.md`.

## E2E runs

- PR #11: `size_guide_panel` / `search_typo_suggest` — SFN `4541b483-…`
- PR #14: `listing_outlet_banner` / `checkout_secure_seal` — SFN `0301478b-…`
- Shop: https://dj37uarwx2jpn.cloudfront.net/
- Datafile: https://d1jcup3snfgsrs.cloudfront.net/featurevisor/production/featurevisor-all.json

MCP handoff for Claude: `docs/handoff-mcp-for-claude.md`
