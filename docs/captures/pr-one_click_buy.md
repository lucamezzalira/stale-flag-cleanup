## Flag cleanup: `one_click_buy`

**Verdict:** safe_to_remove
**Collapse:** keep_gated_branch (target_value=true)
**Run:** run_20261008T142900

Featurevisor marked one_click_buy as deprecated, structural checks passed, and target_value=true supports collapse_direction=keep_gated_branch.

### Evidence
```json
{
  "window_days": 90,
  "min_session_share": 0.005,
  "min_events_for_settled": 1000,
  "rollout_percentage": 100,
  "deprecated": 1,
  "archived": 0,
  "parent_key": "",
  "evaluated_events": 131865,
  "blocked_events": 0,
  "variation_counts": {
    "true": 131865
  },
  "descendants": []
}
```

Gates: tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist.
