## Flag cleanup: `promo_banner_2025`

**Verdict:** safe_to_remove  
**Collapse:** delete_gated_branch (target_value=false)  
**Route:** lifecycle (Featurevisor `deprecated: true`)

Flag had zero evaluated events in the window and is marked deprecated. Collapse deletes the gated banner branch.

### Gates
tsc, vite build, featurevisor lint/test, flag-key grep, security allowlist
