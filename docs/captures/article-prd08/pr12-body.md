## Flag cleanup batch

**Branch:** `agent/cleanup-run_20261015T123653`

Removed 2 independently `safe_to_remove` flag(s) in one all-or-nothing PR.

## Decision (harness)

Authoritative safety decision from Tinybird REST `flag_safety_check` re-verify. The model does not supply or alter this section.

**Run:** run_20261015T123653
**Gates:** tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist

### `catalog_clearance_rail`
- **Verdict:** safe_to_remove
- **Route:** abandoned
- **Reason:** Flag catalog_clearance_rail had zero evaluated events in the window, no live-build hits, and target_value=false supports collapse.
- **Collapse:** delete_gated_branch (target_value=false)
- **Evaluated events:** 0

### `checkout_trust_badges`
- **Verdict:** safe_to_remove
- **Route:** settled
- **Reason:** Flag checkout_trust_badges is settled: 135927 evaluations, rollout=100%.
- **Collapse:** keep_gated_branch (target_value=true)
- **Evaluated events:** 135927


## Evidence, retrieved via Tinybird MCP

Based on the live evidence from Tinybird:

The flag catalog_clearance_rail recorded zero evaluated events in the observation window and had no live-build hits. The target value is false and the datafile revision is 20.

The flag checkout_trust_badges recorded 135927 evaluated events with a rollout percentage of 100. The evaluating share was approximately 5.16 percent. The target value is true and the datafile revision is 20. There were no blocked events.

_Retrieved via Tinybird MCP at 2026-10-15T12:38:33.065Z. Endpoints: flag_safety_check, cleanup_report_.

