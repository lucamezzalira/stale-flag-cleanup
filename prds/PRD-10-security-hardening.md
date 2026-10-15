# PRD-10: Security and Hardening Before Publication

See the authoring prompt in the conversation that opened this work. Summary of decisions:

1. **Tokens split** into `browser_events`, `defs_publisher`, `adoption_writer`,
   `decision_writer`. `flag_daily_activity` has no APPEND token (MV only). Old
   `append_events` rotated after deploy.
2. **Publishing branch:** `demo` remains the agent target and the **only** branch that
   triggers `publish-flags.yml` / assumes `stale-flags-gha-publish`. Agent target unchanged.
3. **Branch protection** on `main` and `demo` (PR + review, no force-push).
4. **Parity CI** on PRs touching `tinybird/` or `packages/verdicts/`.
5. **SNS** failure alerts + Step Functions overlap gate (`AlreadyRunning`).
6. **Sorting key** on `flag_daily_activity` leads with `flag_key`.
7. **Network note** in `infra/README.md` for the public-subnet PoC shortcut.
