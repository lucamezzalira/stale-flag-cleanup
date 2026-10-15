# Infra (AWS CDK, us-east-1)

Aligns with Tinybird `api.us-east.aws.tinybird.co`. Diagrams live in the root [`README.md`](../README.md).

## What this stack deploys

| Resource | Purpose |
|---|---|
| S3 + CloudFront (web) | Northline demo shop SPA |
| S3 + CloudFront (datafiles, 60s TTL, OAC) | Remote Featurevisor `datafileUrl` |
| Secrets Manager `stale-flags/agent` | GitHub + Tinybird REST/MCP/decision tokens (`pnpm infra:secrets` only) |
| Step Functions `stale-flags-cleanup` | Overlap gate → Scout → Choice → one Surgeon session → Succeeded |
| ECS Fargate scout (ARM64, smaller) | Tinybird REST plan → S3 `plan.json` (no Bedrock, no MCP) |
| ECS Fargate surgeon (ARM64) | REST re-verify + Bedrock edit + MCP evidence narrative + one PR |
| S3 results bucket | Plan / surgeon result handoff |
| EventBridge Scheduler `stale-flags-sfn-nightly-utc` | Midnight UTC StartExecution |
| SNS `stale-flags-agent-failures` | Email (optional `alertEmail` CDK context) on FAILED / TIMED_OUT / ABORTED |
| IAM role `stale-flags-gha-publish` | GitHub Actions OIDC for publish-flags (**demo** branch only) |

Agent host is **ECS Fargate under Step Functions** (EventBridge Scheduler nightly). CodeBuild is not the agent host.

Merge gate = GitHub branch protection (PR + review). Failed nights alert via SNS when
`alertEmail` is set in CDK context (`pnpm infra:deploy -c alertEmail=you@example.com`).

## Networking (PoC shortcut)

Fargate tasks run in **public subnets with public IPs** and **no NAT gateway**. That keeps
this PoC cheap: tasks pull images and call Tinybird, Bedrock, GitHub, and AWS APIs over
the public internet. Security groups still allow **no inbound** traffic to the tasks.

Do not copy this shape for production. Prefer private subnets plus a NAT gateway, or VPC
endpoints for ECR, S3, Secrets Manager, CloudWatch Logs, and Bedrock, so tasks never need
public IPs.

## Commands

```bash
pnpm infra:bootstrap
pnpm infra:deploy -c alertEmail=you@example.com   # needs Docker for scout/surgeon images
pnpm infra:secrets
pnpm infra:sync
pnpm infra:agent-run   # prints executionArn
```

Useful outputs: `AgentStateMachineArn`, `AgentResultsBucketName`, `WebUrl`, `GitHubPublishRoleArn`.
