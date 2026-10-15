# Infra (AWS CDK, us-east-1)

Aligns with Tinybird `api.us-east.aws.tinybird.co`. Diagrams live in the root [`README.md`](../README.md).

## What this stack deploys

| Resource | Purpose |
|---|---|
| S3 + CloudFront (web) | Northline demo shop SPA |
| S3 + CloudFront (datafiles, 60s TTL, OAC) | Remote Featurevisor `datafileUrl` |
| Secrets Manager `stale-flags/agent` | GitHub + Tinybird REST/MCP tokens (`pnpm infra:secrets` only) |
| Step Functions `stale-flags-cleanup` | Scout → Choice → one Surgeon session → Succeeded |
| ECS Fargate scout (ARM64, smaller) | Tinybird REST plan → S3 `plan.json` (no Bedrock, no MCP) |
| ECS Fargate surgeon (ARM64) | REST re-verify + Bedrock edit + MCP evidence narrative + one PR |

| S3 results bucket | Plan / surgeon result handoff |
| EventBridge Scheduler `stale-flags-sfn-nightly-utc` | Midnight UTC StartExecution |
| IAM role `stale-flags-gha-publish` | GitHub Actions OIDC for publish-flags |

Agent host is **ECS Fargate under Step Functions** (EventBridge Scheduler nightly). CodeBuild is not the agent host.

Merge gate = GitHub PR notifications. No SNS topic.

## Commands

```bash
pnpm infra:bootstrap
pnpm infra:deploy      # needs Docker for scout/surgeon images
pnpm infra:secrets
pnpm infra:sync
pnpm infra:agent-run   # prints executionArn
```

Useful outputs: `AgentStateMachineArn`, `AgentResultsBucketName`, `WebUrl`, `GitHubPublishRoleArn`.
