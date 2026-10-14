# PRD-05: Human Surface, Decision Log and README

Depends on: PRD-02 `cleanup_report` endpoint and the `cleanup_decisions` datasource.

## Goal

Give a developer a way to see what the agent is about to do tonight and why it did what it
did last night, without building a dashboard. Give a reader a way to run the whole thing in
a few minutes.

## Why not a dashboard

Tinybird is the backend serving layer, not a visualisation tool, and the piece argues that
the value is a governed query surface rather than a screen. Building a dashboard would
contradict the argument and add days of work that the article never shows. The human surface
is the same endpoints, consumed through MCP or a CLI.

## MCP consumption

A developer connects the Tinybird MCP server in their editor, scoped to the three endpoints
from PRD-02 and nothing else, and asks in plain language:

- which flags are queued for deletion tonight
- why `checkout_redesign` keeps getting skipped
- why `one_click_buy` is a candidate when it is one of the busiest flags we have
- what happens to the wishlist chain if `wishlist` is turned on

The answers come from `cleanup_report` and `flag_safety_check`. No new component is needed
for this. What is needed is that the `reason` field reads as a sentence a human understands
without the evidence object, because the model will relay it more or less verbatim.

Document the exact MCP configuration in the repository README, including how to scope the
token. This is one of the more reproducible parts of the article, so it should be copy and
paste.

## CLI report (`/tools/report`)

For readers who clone the repository without an MCP client.

`pnpm report` calls `cleanup_report` and prints a table: flag key, route, verdict, collapse
direction, reason, parent, descendant count, last evaluated. Colour the verdicts. Keep it to
one screen for eight flags. Print timestamps in UTC with the suffix shown.

`pnpm report --flag <key>` calls `flag_safety_check` and prints the full evidence, including
the per build breakdown with session shares and the per variation counts, so both the stale
build case and the settled case are visible as numbers rather than as claims.

`pnpm report --history` reads `cleanup_decisions` and prints recent runs with their verdicts
and pull request links.

## Decision log

`cleanup_decisions` is written only by real agent runs, never seeded. It is the audit trail.

The question it answers is the one that arrives weeks later: why was this flag not deleted,
or why was that code path removed and collapsed in that direction. Being able to answer that
with a query rather than an archaeology exercise is the point, and it is worth a short
section in the article.

Be precise about what this is not. It is not a results dataset. The PoC must not publish
statistics about how often the agent was right, because the data is synthetic and those
numbers would be manufactured. The log records what the evidence said at the moment a
decision was taken, which is true regardless of where the data came from.

## README

The README is part of the deliverable, not an afterthought, because reproducibility is part
of what the article is selling. It must contain, in this order:

1. One paragraph on what the project demonstrates and the fact that all telemetry is
   synthetic
2. Prerequisites and the environment variables needed
3. A quickstart that gets someone from clone to seeing a refusal: install, seed, publish
   definitions, run the report, run the scout in dry run
4. Copy and paste MCP configuration with a scoped token
5. A short architecture diagram or description, signals in, endpoints out, agent on top
6. A note that the agent opens pull requests against the `demo` branch and never `main`

The quickstart has to work on a clean machine. Test it on one before the draft goes out.

## Acceptance criteria

- With the Tinybird MCP connected and scoped to the three endpoints, asking which flags are
  queued for deletion returns the correct answer with reasons that read as sentences
- Asking why `one_click_buy` is a candidate returns an explanation of the settled case that
  a developer would accept without further questions
- `pnpm report` prints all eight flags with their routes, verdicts and collapse directions
  in a readable table
- `pnpm report --flag checkout_redesign` shows the old build, its session share and its daily
  evaluation count
- `pnpm report --flag shipping_estimator` shows both variations with their counts and the
  empty target value
- `pnpm report --history` shows decisions from real runs only
- The README quickstart works end to end on a clean machine
