# PRD-02: Tinybird Data Layer

Depends on: PRD-00 for all four datasource contracts and the eight flag scenarios.

This is the most important PRD in the set. The argument of the whole piece lives in the
verdict logic here, not in the agent.

## Goal

Four datasources, one materialised view, and three API Endpoints. The endpoints are the only
interface anything else is allowed to use. Nothing outside Tinybird decides whether a flag is
safe to remove, or what value it collapses to.

## Before you start

Check the current Tinybird project file format, CLI commands and Events API shape against
docs.tinybird.co. The syntax has changed across versions and the descriptions below are
intent rather than exact syntax. The schemas and the verdict logic are the requirement.

All computation is in UTC.

## Datasources

Implement `flag_evaluations`, `build_adoption`, `flag_definitions` and `cleanup_decisions`
exactly as specified in PRD-00.

Guidance on engines and sorting:

- `flag_evaluations` is the high volume source. Sort by `flag_key`, then `app`, then
  `timestamp`, because every query filters on flag key and a time window. Consider a TTL
  well beyond the longest window the endpoints support.
- `build_adoption` is small and append only, one row per build per day.
- `flag_definitions` is small and append only. Queries must always reduce to the latest
  `captured_at` per `flag_key`, so never assume one row per flag.
- `cleanup_decisions` is append only and is written by the agent, never updated.

## Materialised view

`flag_daily_activity`, rolling raw evaluations into daily counts so ninety day questions do
not scan the raw stream.

Dimensions: `day`, `flag_key`, `app`, `build_id`, `outcome`, `variation`.
Measure: event count.

Keeping `variation` as a dimension is what makes the settled rule cheap. Without it the
settled check has to scan raw events.

Every endpoint should read from this view rather than from `flag_evaluations`, except where
an endpoint needs the most recent individual event timestamp.

## Endpoint 1: `flag_candidates`

Parameters:

- `window_days` (Int, default 90)
- `environment` (String, default `production`)

Returns every flag that is a candidate for removal by either route.

**Abandoned route.** Zero `evaluated` events in the window.

**Settled route.** Evaluated events above a meaningful floor in the window, every one of
them carrying the same `variation`, and `rollout_percentage` at 0 or 100 in the latest
definitions snapshot.

Exclusions that apply to both routes, and these matter more than they look:

- The flag must be present in the latest `flag_definitions` snapshot. A flag that has been
  removed from the Featurevisor project stops receiving snapshots, so it must drop out of
  the candidate list rather than being proposed again forever. Being absent is different
  from being archived, and both exclude it.
- The flag must have existed before the window opened.
- The flag must not already have an open pull request, which the scout enforces separately
  in PRD-04, but the endpoint should expose `last_verdict` and `last_pr_url` from
  `cleanup_decisions` so the scout can do that cheaply.

Per row: `flag_key`, `route`, `last_evaluated_at`, `evaluated_events`, `blocked_events`,
`distinct_variations`, `parent_key`, `descendant_count`, `last_verdict`, `last_pr_url`.

This endpoint does not decide anything. It narrows the list.

## Endpoint 2: `flag_safety_check`

This is the core of the PoC.

Parameters:

- `flag_key` (String, required)
- `window_days` (Int, default 90)
- `min_session_share` (Float, default 0.005)
- `min_events_for_settled` (Int, default 1000)
- `environment` (String, default `production`)

Returns a single row: `flag_key`, `verdict`, `reason`, `target_value`, `collapse_direction`
and an `evidence` object.

### Verdict rules, evaluated in this order

1. **No longer defined.** If the flag is absent from the latest `flag_definitions` snapshot,
   return `blocked` with a reason stating the flag is no longer in the project and there is
   nothing to remove. This stops the system proposing a deletion it already made.

2. **Living descendants.** Resolve the dependency tree from the latest snapshot. If this flag
   has any descendant that is not archived, return `blocked` with a reason naming those
   descendants and stating that removal must proceed bottom up. This rule fires before any
   traffic analysis, because the dependency problem is not a traffic problem.

3. **No single target value.** If `target_value` is empty in the latest snapshot, meaning the
   rollout sits strictly between 0 and 100 or weight is spread across more than one
   variation, return `blocked` with a reason stating the rollout percentage, that the flag
   is mid-ramp, and that the rollout must be completed or rolled back before the code can be
   collapsed. There is no safe value to inline, so nothing else about the flag matters.

4. **Active on a live build.** Join evaluated events in the window against `build_adoption`.
   If any build with `session_share >= min_session_share` produced `evaluated` events, return
   `blocked` with a reason naming the build, its release date, its session share and the
   daily event count. This is the stale bundle case, and it applies to the abandoned route
   only, since a settled flag is active everywhere by definition.

5. **Gated by a parent.** If the flag has a parent, and the window contains
   `blocked_by_parent` events but no `evaluated` events, return `inconclusive` with a reason
   stating that the flag was never reached because the parent gated every lookup, that the
   absence of evaluations is therefore not evidence of disuse, and that the parent's rollout
   state must be resolved first. Include the blocked event count.

6. **Insufficient evidence.** If total events in the window are above zero but below a
   configurable floor, or the flag's first ever event is inside the window, return
   `inconclusive` with a reason stating the evidence is too thin to support a decision.

7. **Safe.** Only if none of the above apply, return `safe_to_remove` with a reason stating
   which route qualified it, the window searched, the number of builds checked, and either
   the last time the flag was ever evaluated (abandoned) or the number of evaluations that
   all returned the same value (settled).

### Target value and collapse direction

Every response carries `target_value` and `collapse_direction`, taken from the latest
definitions snapshot and never inferred from anything else:

- `collapse_direction` is `keep_gated_branch` when the target value is the enabled value,
  `delete_gated_branch` when it is the disabled value, and `none` when there is no single
  value.
- A `safe_to_remove` verdict must never be returned with `collapse_direction: none`. If that
  combination is ever possible the rules are wrong.

This is what stops the agent inferring the target from the code, which is the single most
dangerous failure the system can have.

### The reason field

The `reason` is a human readable sentence. It is read by a developer in their editor, it
goes into the pull request description, and it is stored in `cleanup_decisions`. Write it as
a sentence, not a code.

The `evidence` object carries the numbers behind the verdict: per build evaluated counts and
session shares, distinct variations with their counts, blocked counts and the blocking
parent, the descendant list, the rollout percentage, the window used and the thresholds
applied.

### Why this must be SQL

A reviewer has to be able to read the rule that authorises an agent to delete code. If the
rule lives in a prompt, nobody can review it, version it, or explain months later why a
deletion was approved. Keep every threshold as an endpoint parameter with a default, so the
rule is both visible and tunable without touching the agent.

## Endpoint 3: `cleanup_report`

Parameters: `window_days`, `environment`.

Returns the full current picture in one call, one row per candidate, each with its route,
verdict, reason, collapse direction, parent, descendants and headline evidence numbers. This
is the human facing surface, consumed through the Tinybird MCP server or by the CLI report
in PRD-05.

It must be readable as a table. Keep the column count low and put the detail in `reason`.

## Acceptance criteria

Against the seeded dataset from PRD-03:

- `flag_candidates` returns all eight flags, with `route` set to `settled` for
  `one_click_buy` and `shipping_estimator` and `abandoned` for the rest
- `flag_safety_check` returns `safe_to_remove` for exactly `promo_banner_2025` and
  `one_click_buy`
- `promo_banner_2025` returns `collapse_direction: delete_gated_branch`
- `one_click_buy` returns `collapse_direction: keep_gated_branch`
- `checkout_redesign` returns `blocked` naming the old build, its session share and its
  daily evaluation count
- `shipping_estimator` returns `blocked` for the partial rollout, naming the percentage,
  with `collapse_direction: none`
- `wishlist` returns `blocked` naming its two living descendants
- `wishlist_sharing` and `wishlist_sharing_qr` return `inconclusive` with the parent gating
  reason and a blocked event count above zero
- `search_ranking_v2` returns `inconclusive` for thin evidence
- Removing a flag from the latest definitions snapshot makes it disappear from
  `flag_candidates` and return the not-defined reason from `flag_safety_check`
- Changing `window_days` to 7 changes the verdicts in a way that makes sense, proving the
  window is a real parameter rather than decoration
- `cleanup_report` returns all eight rows in one call
- No endpoint exposes raw table access, and nothing outside Tinybird computes a verdict or a
  target value
