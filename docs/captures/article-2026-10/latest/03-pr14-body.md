https://github.com/lucamezzalira/stale-flag-cleanup/pull/14
## Flag cleanup batch

**Branch:** `agent/cleanup-run_20261015T125722`

Removed 2 independently `safe_to_remove` flag(s) in one all-or-nothing PR.

## Decision (harness)

Authoritative safety decision from Tinybird REST `flag_safety_check` re-verify. The model does not supply or alter this section.

**Run:** run_20261015T125722
**Gates:** tsc, vite build, featurevisor lint/test, flag-key grep, security diff allowlist

### `checkout_secure_seal`
- **Verdict:** safe_to_remove
- **Route:** settled
- **Reason:** Flag checkout_secure_seal is settled: 135927 evaluations, rollout=100%.
- **Collapse:** keep_gated_branch (target_value=true)
- **Evaluated events:** 135927

### `listing_outlet_banner`
- **Verdict:** safe_to_remove
- **Route:** abandoned
- **Reason:** Flag listing_outlet_banner had zero evaluated events in the window, no live-build hits, and target_value=false supports collapse.
- **Collapse:** delete_gated_branch (target_value=false)
- **Evaluated events:** 0


## Evidence, retrieved via Tinybird MCP

The flag checkout_secure_seal recorded 135927 evaluation events with an evaluating share of 97.8% and rollout at 100 percent. The target value is true and there were no blocked events. 

The flag listing_outlet_banner recorded zero evaluation events with an evaluating share of 0%. The target value is false and rollout is at 0 percent. There were no blocked events.

_Retrieved via Tinybird MCP at 2026-10-15T12:59:06.878Z. Endpoints: flag_safety_check, cleanup_report_.

