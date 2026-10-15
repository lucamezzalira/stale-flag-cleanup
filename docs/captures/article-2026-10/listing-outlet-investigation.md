# listing_outlet_banner vs live shop evaluations

Investigation for PRD-09 (pre–PRD-10 shop build). Flag removed in PR #14.

## Questions

1. Does the CloudFront shop send events to Tinybird?
2. If yes, why did safety check count zero evaluated events?
3. Is badge text `evaluated` accurate for a flag that returns false?

## Answers (at investigation time)

1. **No (then).** That CloudFront bundle baked empty `eventsUrl` / `eventsToken`.
   Workspace `flag_evaluations` / `session_beacons` had no live rows from the shop.
2. N/A for live events. Synthetic activity for this flag was entirely **before** the
   90-day window, so in-window evaluated count was 0 (abandoned was correct for seed).
3. **Yes for the SDK.** FlagCallout prints the Featurevisor outcome (`evaluated` means
   the page asked and got a result, including `false` / off). It does **not** mean
   Tinybird ingested a row.

## Current state (PRD-10+)

- Shop ships scoped `browser_events` (`VITE_TINYBIRD_BROWSER_EVENTS_TOKEN`) for
  evaluations + beacons only. It cannot append `flag_definitions` or decisions.
- Agent eligibility still comes from **synthetic seed**, not from live shop traffic.
- `listing_outlet_banner` is gone from Featurevisor / the datafile (PR #14).

## Choice for the article

Do not claim live shop streaming drove the agent’s removal decisions. Drop any TODO
that still treats this investigation as open work.
