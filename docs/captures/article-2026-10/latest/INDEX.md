# Article captures (PRD-08 latest)

Skip shot 1 (architecture; user has it).

| # | File | What |
|---|---|---|
| 2 | `02-scout-dry-run.png` + `02-scout-dry-run.txt` | Scout dry-run `source=tinybird-rest`, all verdicts including `nav_winter_ribbon` blocked |
| 3 | `03-pr14-body.png` + `03-pr14-body.md` | PR #14 Decision (abandoned+settled) + evidence with 97.8% share + MCP footer |
| 4 | `04-pr14-diffs-side-by-side.png` | PR #14 diffs: `listing_outlet_banner` delete_gated vs `checkout_secure_seal` keep_gated |
| 5a | `05a-listing-before-outlet.png` | Listing before (outlet callout present, winter still live) |
| 5b | `05b-checkout-before-seal.png` | Checkout before (`checkout_secure_seal` callout on) |
| 5c | `05c-listing-after-outlet-gone.png` | Listing after (outlet plumbing gone; winter still blocked) |
| 5d | `05d-checkout-after-seal-kept.png` | Checkout after (secure seal text kept, flag callout gone) |
| 6 | `06-pr11-narrative-516-percent-crop.png` | PR #11 evidence crop quoting “5.16 percent” |
| 7 | `07-mcp-queued.png` | Developer asking Tinybird MCP “what’s queued tonight?” |

## Run artefacts

- PR: https://github.com/lucamezzalira/stale-flag-cleanup/pull/14 (merged)
- Step Functions: `arn:aws:states:us-east-1:661975750538:execution:stale-flags-cleanup:0301478b-1237-456f-95d0-4f3eee14894d` (`execution-arn.txt`)
- Dry-run text: `02-scout-dry-run.txt`
