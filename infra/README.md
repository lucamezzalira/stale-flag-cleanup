# Infra (AWS CDK, us-east-1)

Aligns with Tinybird `api.us-east.aws.tinybird.co`. Logical + AWS Mermaid diagrams and the nightly sequence live in the root [`README.md`](../README.md).

## What this stack deploys

| Resource | Purpose |
|---|---|
| S3 + CloudFront (web) | Northline demo shop SPA |
| S3 + CloudFront (datafiles, 60s TTL, OAC) | Remote Featurevisor `datafileUrl` |
| Secrets Manager `stale-flags/agent` | GitHub + Tinybird tokens (written only by `pnpm infra:secrets`) |
| Step Functions `stale-flags-cleanup` | Scout → Choice → Map(Surgeon) → SNS notify |
| ECS Fargate (ARM64) | Worker tasks: clone `demo`, Tinybird + Bedrock, open PRs |
| S3 results bucket | Scout/surgeon JSON handoff for ASL (`RESULT_S3_URI`) |
| SNS `stale-flags-merge-gate` | Merge-gate notice (no auto-merge) |
| EventBridge Scheduler `stale-flags-sfn-nightly-utc` | Midnight UTC → `states:StartExecution` (`retryAttempts: 0`) |
| IAM role `stale-flags-gha-publish` | GitHub Actions OIDC for `.github/workflows/publish-flags.yml` |

Surgeon runs as a Fargate task (up to ~25 minutes). It is not a zip Lambda.

## Commands

```bash
# From repo root (AWS credentials + region us-east-1)
pnpm infra:bootstrap   # once per account/region
pnpm infra:deploy      # needs local Docker for the agent image asset
pnpm infra:secrets     # push .env tokens into Secrets Manager
pnpm infra:sync        # upload datafile + web build + CloudFront invalidation

# On-demand agent run in AWS (same as the nightly schedule)
pnpm infra:agent-run
# → prints executionArn; watch in Step Functions console or:
# aws stepfunctions describe-execution --execution-arn "$ARN" --region us-east-1
```

After deploy, add GitHub repo secret `AWS_GHA_PUBLISH_ROLE_ARN` = stack output `GitHubPublishRoleArn` so `publish-flags.yml` can assume the OIDC role.

Useful outputs: `AgentStateMachineArn`, `AgentResultsBucketName`, `AgentNotifyTopicArn`, `WebUrl`.

GitHub may emit OIDC `sub` as `repo:owner/repo:ref:…` or the ID form `repo:owner@id/repo@id:ref:…`. The role trust allows both. The GHA role also needs `cloudformation:DescribeStacks` on `StaleFlagsStack` to resolve bucket/distribution outputs.

If the account already has a GitHub OIDC provider, redeploy with:

```bash
pnpm --filter @stale-flags/infra exec cdk deploy -c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

## Cost (dev / demo)

Idle is typically a few USD/month (CloudFront + S3 + Secrets + idle VPC). Fargate, Step Functions, and Bedrock only bill when the agent runs.
