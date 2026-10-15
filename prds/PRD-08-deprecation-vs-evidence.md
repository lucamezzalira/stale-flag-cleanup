# PRD-08: Deprecation Is a Request, Evidence Is the Permission

## Problem

Lifecycle rules (`deprecated` / `archived` → `safe_to_remove`) sat **above** the live
minority-build block in `flag_safety_check` / `cleanup_report` and in
`packages/verdicts`. PR #11 removed `search_typo_suggest` via lifecycle despite ~5%
evaluating share on live builds.

Principle: **a declaration in the flag tool can make a flag a candidate, but only
evidence can make it safe.**

## Changes

1. Reorder verdict / route / reason cascades so minority-build and thin-evidence checks
   run before lifecycle `safe_to_remove`.
2. Mirror the same order in TypeScript with unit tests.
3. New fixtures: `catalog_clearance_rail` (abandoned), `checkout_trust_badges` (settled),
   `nav_winter_ribbon` (deprecated but live → blocked).
4. Cloud E2E must remove only the abandoned + settled pair.

## Pitfall (docs)

Lifecycle markers made flags eligible before live traffic was checked (PR #11);
deprecation now only makes a flag a candidate.
