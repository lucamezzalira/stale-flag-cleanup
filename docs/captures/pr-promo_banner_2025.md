## Flag cleanup: `promo_banner_2025`

**Verdict:** safe_to_remove
**Collapse:** delete_gated_branch (target_value=false)
**Run:** run_20261008T142900

Featurevisor marked promo_banner_2025 as deprecated, structural checks passed, and target_value=false supports collapse_direction=delete_gated_branch.

### Evidence
```json
{
  "window_days": 90,
  "min_session_share": 0.005,
  "min_events_for_settled": 1000,
  "rollout_percentage": 0,
  "deprecated": 1,
  "archived": 0,
  "parent_key": "",
  "evaluated_events": 0,
  "blocked_events": 0,
  "variation_counts": {},
  "descendants": []
}
```

Gates: tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist.
