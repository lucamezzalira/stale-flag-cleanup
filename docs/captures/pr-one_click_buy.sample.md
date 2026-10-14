## Flag cleanup: `one_click_buy`

**Verdict:** safe_to_remove  
**Collapse:** keep_gated_branch (target_value=true)  
**Route:** lifecycle (Featurevisor `deprecated: true`)

Heavy settled traffic all returning the same variation; marked deprecated. Collapse keeps one-click buy and removes the fallback CTA.

### Gates
tsc, vite build, featurevisor lint/test, flag-key grep, security allowlist
