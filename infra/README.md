# Infra (AWS CDK, us-east-1)

Aligns with Tinybird `api.us-east.aws.tinybird.co`.

## What this stack deploys

| Resource | Purpose |
|---|---|
| S3 + CloudFront (web) | Northline demo shop SPA |
| S3 + CloudFront (datafiles) | Remote Featurevisor `datafileUrl` |
| Secrets Manager `stale-flags/agent` | GitHub + Tinybird tokens for the agent |
| CodeBuild `stale-flags-agent` | Clones the repo and runs `pnpm agent:run` |
| EventBridge Scheduler | Midnight UTC → start that CodeBuild project |

AgentCore Runtime for the surgeon can replace CodeBuild later; the schedule + secrets story is the same.

Not in scope: AgentCore Gateway in front of Tinybird.

## Commands

```bash
# From repo root (AWS credentials + region us-east-1)
pnpm infra:bootstrap   # once per account/region
pnpm infra:deploy
pnpm infra:sync        # upload datafile + web build

# Fill secrets after first deploy (uses local .env)
pnpm infra:secrets

# On-demand agent run in AWS (same as the nightly schedule)
pnpm infra:agent-run
```

## Cost (dev / demo)

Idle is typically a few USD/month (CloudFront + S3 + Secrets). CodeBuild only bills when the agent runs.
