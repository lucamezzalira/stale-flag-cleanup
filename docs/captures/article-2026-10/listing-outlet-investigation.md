# listing_outlet_banner vs live shop evaluations

## Questions

1. Does the CloudFront shop send events to Tinybird?
2. If yes, why did safety check count zero evaluated events?
3. Is badge text `evaluated` accurate for a flag that returns false?

## Answers

1. **No.** Production bundle has `eventsUrl:""` and `eventsToken:""`. Workspace
   `flag_evaluations` and `session_beacons` have 0 rows.
2. N/A for live events. Synthetic `flag_daily_activity` for this flag is entirely
   **before** the 90-day window (1750 events, 2026-06-07..2026-07-11). In-window count is 0,
   so abandoned was correct for seeded data.
3. **Yes for the SDK.** FlagCallout prints the Featurevisor outcome (`evaluated` means the
   page asked and got a result, including `false` / off). It does **not** mean Tinybird
   ingested a row.

## Choice

Document the gap in `README.md` (PRD-09 option 2). Do not reseed or reclassify the abandoned
fixture. Correct article copy that claims the live shop streams evaluations into Tinybird.
