# PRD-03: Synthetic Data Generator

Depends on: PRD-00 for the eight scenarios and the datasource contracts.

## Goal

A generator that produces a backdated ninety day history realistic enough that the verdicts
in PRD-02 fall out of the data rather than being staged, plus a live trickle mode for
demonstrating continuous ingestion.

The whole dataset must load in seconds. The feedback loop depends on this.

## Why backdating rather than waiting

The claim "this flag has had no evaluations in ninety days" has to be true the moment the
seed finishes. The generator writes timestamps running from ninety days ago up to now, in
UTC, so the window has already elapsed. Nothing in this PoC ever waits for real time to pass.

Every window in the endpoints is a parameter, so during development the same mechanism can
be exercised at seven days or two hours while the article talks about ninety.

## Check the volume budget first

Before writing the generator, work out how many rows a full ninety day seed produces at the
intended traffic level, and check that against the limits of the Tinybird plan in use.
Discovering the ceiling at seed time costs an afternoon. If the budget is tight, reduce the
baseline session count rather than the window, because the window is what the article talks
about and the absolute traffic level is not.

## Realism requirements

Flat random noise will look fake to anyone who has read a real traffic chart, and the whole
credibility of the refusal depends on the data looking plausible. The generator must produce:

- **Daily seasonality.** A diurnal curve with a weekday peak, quieter overnight, lower at
  weekends. Build it from a simple per-hour weight table rather than anything elaborate.
- **Session structure.** Events belong to sessions. A session has a user, a build, a
  duration, and several flag lookups within it. Do not emit independent events with random
  user ids.
- **Build cohorts.** Multiple builds live at once, with newer builds taking share over time
  and older ones decaying rather than disappearing on a cliff edge. Releases land roughly
  weekly, with the odd gap.
- **Growth and wobble.** Traffic trends gently upward across the window with day to day
  variance, not a flat line.
- **Flag lookup realism.** Flags are not read once per session. A flag on a hot path is
  evaluated many times, a flag on a rarely visited page is evaluated occasionally.

Seed the random source so runs are reproducible, and expose the seed as a parameter.

## Scenario construction

Build each scenario by shaping the traffic, not by writing the verdict. If the endpoint has
to be told the answer, the PoC proves nothing.

**`loyalty_stamp_banner`.** Active traffic ending well before the window opens, nothing (or
near-nothing) inside it. Give it a visible tail in the data before the cut so a chart shows
a feature that was shipped and then went quiet. Paired with 0% rollout →
`delete_gated_branch`.

**`express_pay_hint`.** Heavy, healthy traffic right across the window, on the checkout path
so the volume is high. Every evaluated event carries the same variation, because the rollout
has been at 100% for months. This is the settled / keep_gated case and it must look
completely alive in every chart, which is exactly why a rule based only on absence of
traffic would never find it.

**`checkout_redesign`.** Healthy evaluation traffic from builds older than about three
months, then nothing from any build released since. One specific older build, released
roughly three months ago, continues producing a few hundred evaluations a day right up to
the present, holding a session share around two to four percent and decaying slowly. The
corresponding `build_adoption` rows must support that share, because the endpoint joins on
them.

**`shipping_estimator`.** Steady traffic across the window with evaluations split roughly
sixty to forty across its two variations, consistently, for the whole period. The split has
to be stable rather than drifting, because the story is a ramp that was started and then
abandoned rather than one still in progress.

**`wishlist`.** Parent at 0% rollout for the whole window. It should still show `evaluated`
events, because the application asks about it and gets a negative answer. That is a useful
detail: the parent is evaluated, the children are not reached.

**`wishlist_sharing` and `wishlist_sharing_qr`.** Zero `evaluated` events across the window
and thousands of `blocked_by_parent` events, with `blocked_by` set to the immediate parent
at each level. Volumes should track the wishlist page traffic, so the blocked counts follow
the same seasonality as everything else.

**`search_ranking_v2`.** Between five and fifteen `evaluated` events across the entire
window, scattered. Enough to prove it is not dead, far too few to conclude anything.

## Outputs

### `build_adoption`

One row per build per day across the window, with `session_share` summing to approximately
one per day, release dates consistent with the cohorts, and the three month old build
retaining its small share through to the present.

### `flag_definitions`

Snapshot rows reflecting the Featurevisor project, including the `parent_key` chain, the
`rollout_percentage`, the derived `target_value` and `variation_count`. In normal operation
these are published by the CI step in PRD-01; the generator writes them for seeding so the
data layer can be developed before CI exists. The two must agree on shape, so share the
derivation logic rather than writing it twice.

`shipping_estimator` must be seeded with an empty `target_value`, because that is what makes
its refusal real rather than hardcoded.

### `cleanup_decisions`

The generator does not write to this. It is written only by real agent runs. Seeding it
would be fabricating an audit trail, which defeats its purpose.

## Modes

- `pnpm seed` truncates the datasources and loads the full backdated history
- `pnpm seed --days 7` loads a shorter window for fast iteration
- `pnpm trickle` emits live events continuously at a realistic rate, for demonstrating
  continuous ingestion while recording or screenshotting
- `--seed <n>` makes a run reproducible

Load through the Events API as NDJSON in batches, with progress output, so the ingestion
path used by the generator is the same one the application uses.

## Acceptance criteria

- A full seed completes in seconds, not minutes, and stays inside the plan's limits
- Running the PRD-02 acceptance checks immediately after seeding produces every expected
  verdict without any further intervention
- A chart of daily events per flag looks like real traffic: diurnal, weekly, trending
- `express_pay_hint` is visibly one of the busiest flags in that chart while still being a
  removal candidate, which is the single most useful image in the article
- Two runs with the same seed produce identical data
- `trickle` only adds events for flags still present in `flag_definitions` (skips keys
  already removed by a cleanup PR)
