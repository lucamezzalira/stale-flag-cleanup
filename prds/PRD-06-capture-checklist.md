# PRD-06: Capture Checklist

This is not a build document. It is the list of artefacts the article needs, captured while
the system is in the state that produces them.

Work through it as you go rather than at the end. Recreating a demo state two days later to
take a screenshot costs half a day, and the draft is due on 15 October.

## Why this exists

Six PRDs build software. The deliverable is a long post on LinkedIn, the same on X, and an
article on Luca's own channels. None of the PRDs produce a single image, and the moments
worth showing only exist while the system is in a particular state.

## The capture list

### The refusals, which are the payload

- [ ] Terminal output of `pnpm agent:scout --dry-run` showing all eight candidates with
      their verdicts side by side. This is the single most useful image in the piece
- [ ] `pnpm report --flag checkout_redesign` showing the old build, its release date, its
      session share and its daily evaluation count
- [ ] `pnpm report --flag shipping_estimator` showing the two variations with their counts
      and the empty target value
- [ ] `pnpm report --flag wishlist` showing the living descendants
- [ ] `pnpm report --flag wishlist_sharing` showing blocked events and zero evaluations

### The two removals, which prove the direction matters

- [ ] Permalink to the `promo_banner_2025` pull request, with the diff visible
- [ ] Permalink to the `one_click_buy` pull request, with the diff visible
- [ ] A side by side of the two diffs showing one deleting the gated branch and the other
      keeping it. This is what proves the agent read the rollout state rather than guessing
- [ ] The pull request body, showing the reason, evidence and run id

Use permalinks to a specific commit, not branch links, because `demo:reset` will move the
branch.

### The data, which proves it is not staged

- [ ] A chart of daily events per flag across the window, showing diurnal and weekly shape
- [ ] The same chart with `one_click_buy` visible as one of the busiest flags while still
      being a removal candidate. This is the image that sells the settled case
- [ ] A row count and a screenshot of the Tinybird datasource after seeding

### The mechanism

- [ ] The two endpoint definitions, as code, specifically the verdict logic in SQL. This is
      the thing the argument rests on and it should appear in the article verbatim
- [ ] The MCP conversation where a developer asks which flags are queued tonight and gets
      the answer with reasons
- [ ] `cleanup_decisions` after a run, showing eight rows with their reasons
- [ ] A screenshot or short recording of the scheduled run firing, for the unattended claim

### The failure case

- [ ] Output from a deliberately broken gate, showing no pull request opened and a `failed`
      row written

## Format notes

Terminal captures should be at a width that reads on a phone, since most of the audience
sees LinkedIn on mobile. Keep the font large and the window narrow rather than capturing a
full width terminal and shrinking it.

Prefer plain text output over screenshots where the content is text, because a code block in
the article is searchable, copyable and readable at any size. Screenshot only what is
genuinely visual: the pull request diffs, the charts, the MCP conversation.

## Before the draft goes out

- [ ] Every link in the article resolves, including the permalinks
- [ ] The repository is on `main`, in a clean state, with the README quickstart working
- [ ] The sponsorship disclosure is present, per the brief
- [ ] The F&F tracking links are in both social posts
- [ ] A note in the article saying all telemetry is synthetic and the generator is in the
      repository

## Metrics obligations, after go-live

These are contractual and easy to forget.

- [ ] Submit the live post links on the day of publication
- [ ] Impressions and engagements at 7 days
- [ ] Impressions and engagements at 30 days
