# PRD-01: Demo Application, Instrumentation and Definitions Publisher

Depends on: PRD-00 for the flag list and the `flag_evaluations` and `flag_definitions`
contracts.

## Goal

A small React application using Featurevisor for feature flags, instrumented so that every
flag lookup emits an evaluation event, plus the CI step that publishes the flag definitions
to Tinybird. The application exists to make the flags real in code. It is not the point of
the article, so it stays deliberately small.

A reader should be able to clone the repo, run one command, and see the flags working.

## Scope

### Featurevisor project (`/featurevisor`)

Set up a standard Featurevisor project with YAML definitions for the eight flags in PRD-00.
Use the real `requiredFeatures` mechanism for the nested chain, not a custom dependency
scheme:

- `wishlist` is a standalone feature
- `wishlist_sharing` declares `requiredFeatures: wishlist`
- `wishlist_sharing_qr` declares `requiredFeatures: wishlist_sharing`

Rollout state in the `production` environment, which must match the table in PRD-00
(when the removable fixtures are present on the branch):

- `loyalty_stamp_banner`: 0% (delete_gated E2E fixture; deprecated)
- `express_pay_hint`: 100% (keep_gated E2E fixture; deprecated)
- `checkout_redesign`: 100%
- `shipping_estimator`: 60%, with two variations so the split is real
- `wishlist`: 0% for the whole window, which is what gates the children
- `wishlist_sharing`: 100%, never reached because the parent gates it
- `wishlist_sharing_qr`: 100%, never reached
- `search_ranking_v2`: 5%

`shipping_estimator` is the only flag with more than one variation. It exists to prove the
agent refuses when there is no single value to collapse to.

Include at least one `tests/` spec per flag so `featurevisor test` and `featurevisor lint`
both have something to do. These are configuration assertions, not application unit tests,
and they are cheap to keep.

Build the datafile into the web app at dev and build time. The datafile revision must be
readable at runtime, because every evaluation event carries it.

### Definitions publisher (`/tools/publish-defs`)

A small script that reads the Featurevisor project and writes one `flag_definitions` row per
flag to Tinybird. It runs in CI on every build, and is runnable locally.

For each flag it must emit `flag_key`, `parent_key` from `requiredFeatures`,
`rollout_percentage` for the named environment, `variation_count`, `archived`,
`datafile_revision`, `environment` and `captured_at` in UTC.

`target_value` is derived, and this is the part to get right:

- rollout at 100% with a single variation: the enabled value
- rollout at 0%: the disabled value
- anything strictly between 0 and 100, or more than one variation carrying weight: empty
  string, meaning there is no single value production serves

The empty string is not a missing value. It is a statement that the rollout is partial, and
PRD-02 turns it into a refusal.

This script is the bridge between the flag tool and Tinybird, and it is the concrete thing
the article points at when it says the definitions have to reach the evidence layer
somehow. Keep it short and readable for that reason.

### Flag client wrapper (`/packages/flag-client`)

A thin wrapper around the Featurevisor JavaScript SDK that is the only way the application
reads a flag. It must:

1. Resolve the flag through the Featurevisor SDK as normal.
2. Determine whether the lookup was a real evaluation or was short-circuited because a
   required parent feature was not satisfied.
3. Emit a `flag_evaluations` event with the correct `outcome`, the resolved `variation` when
   evaluated, and `blocked_by` set to the parent key when blocked.
4. Attach `app`, `build_id`, `datafile_revision`, `user_hash` and `session_id` to every
   event, with the timestamp in UTC.
5. Never block rendering on the event emission, and never throw if the collector is
   unreachable.

Determining the blocked case is the part that needs care. Featurevisor checks required
features first and never reaches the rest, so the wrapper has to read the feature's declared
`requiredFeatures` from the datafile and evaluate the parents itself to establish whether
the lookup was blocked and by which parent. Verify against the current Featurevisor SDK
docs whether it exposes this directly before implementing it by hand.

Recording the resolved `variation` on every evaluated row matters as much as the outcome,
because it is what makes the settled case detectable later.

Events are batched in memory and flushed on an interval and on page hide, posting NDJSON to
the Tinybird Events API. Batch size and flush interval come from environment variables so
the demo can be made chatty or quiet.

`build_id` comes from an environment variable injected at build time in the format
`YYYY-MM-DD.<short-sha>`, falling back to `dev.local` when running locally.

### Web application (`/apps/web`)

React with Vite, client side rendering, no framework beyond that. Enough surface to make
each flag meaningful:

- A product listing page where `loyalty_stamp_banner` shows a loyalty stamp card (delete_gated
  fixture; UI string must be unique so AFTER CDN QA can prove collapse)
- A checkout page gated by `checkout_redesign`, with `express_pay_hint` on the same path
  (keep_gated fixture) and `shipping_estimator` selecting between two estimate presentations
- A wishlist section gated by `wishlist`, containing a share action gated by
  `wishlist_sharing`, containing a QR option gated by `wishlist_sharing_qr`
- A search results page where `search_ranking_v2` selects the ordering

Every one of these reads its flag through the wrapper. No direct SDK calls anywhere in the
application code.

Styling stays minimal. This is not a design exercise and the screenshots in the article are
of pull requests and terminal output, not of the app.

## Out of scope

- Authentication, routing beyond what is needed, state management libraries
- Server side rendering
- Any test suite for the application
- Mobile or micro-frontend variants

## Acceptance criteria

- `pnpm dev` starts the app with flags resolving from a locally built datafile
- Reading any flag produces exactly one event with the correct `outcome` and, when
  evaluated, the resolved `variation`
- Opening the wishlist section with `wishlist` at 0% produces `blocked_by_parent` events for
  `wishlist_sharing` and `wishlist_sharing_qr`, with `blocked_by` naming the correct parent
  at each level
- `shipping_estimator` produces events carrying both of its variations
- Events arrive in the `flag_evaluations` datasource and are visible in Tinybird
- Killing the collector endpoint does not break the application
- `pnpm publish-defs` writes one row per flag, with `target_value` empty for
  `shipping_estimator` and populated for every other flag
- `featurevisor lint` and `featurevisor test` both pass
