# Capture checklist (from PRD-06)

Work through while the system is in the right state. Draft target: 15 October.

## Refusals

- [x] `pnpm agent:scout --dry-run` → [captures/scout-dry-run.txt](captures/scout-dry-run.txt)
- [x] `pnpm report --flag checkout_redesign` → [captures/report-checkout_redesign.json](captures/report-checkout_redesign.json)
- [x] `pnpm report --flag shipping_estimator` → [captures/report-shipping_estimator.json](captures/report-shipping_estimator.json)
- [x] `pnpm report --flag wishlist` → [captures/report-wishlist.json](captures/report-wishlist.json)
- [x] `pnpm report --flag wishlist_sharing` → [captures/report-wishlist_sharing.json](captures/report-wishlist_sharing.json)

## Removals

- [x] Sample PR body `promo_banner_2025` → [captures/pr-promo_banner_2025.sample.md](captures/pr-promo_banner_2025.sample.md)
- [x] Sample PR body `one_click_buy` → [captures/pr-one_click_buy.sample.md](captures/pr-one_click_buy.sample.md)
- [ ] Live GitHub permalinks (needs `GITHUB_TOKEN` + `pnpm agent:run`)
- [ ] Side-by-side diffs after a real surgeon run

## Data

- [x] Seed row counts (activity=3871, adoption=723, defs=8) in scout/seed output
- [ ] Daily events chart (export from `.local-data` or Tinybird UI)
- [ ] Chart highlighting busy `one_click_buy`

## Mechanism

- [x] Verdict logic in `packages/verdicts` (+ Tinybird pipes under `tinybird/`)
- [ ] MCP conversation (when Tinybird MCP connected)
- [ ] `cleanup_decision_log` after `pnpm agent:run`
- [ ] Scheduled run screenshot (after AWS)

## Failure

- [ ] Broken gate → `failed` row, no PR
