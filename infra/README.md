# Infra (AWS CDK, us-east-1)

Aligns with Tinybird `api.us-east.aws.tinybird.co`. Logical + AWS Mermaid diagrams and the nightly sequence live in the root [`README.md`](../README.md).

## What this stack deploys

| Resource | Purpose |
|---|---|
| S3 + CloudFront (web) | Northline demo shop SPA |
| S3 + CloudFront (datafiles, 60s TTL, OAC) | Remote Featurevisor `datafileUrl` |
| Secrets Manager `stale-flags/agent` | GitHub + Tinybird tokens (written only by `pnpm infra:secrets`) |
| CodeBuild `stale-flags-agent` | Clones repo, calls Tinybird MCP/REST + Bedrock Converse, opens PRs (`concurrentBuildLimit: 1`) |
| EventBridge Scheduler | Midnight UTC → start that CodeBuild project (`retryAttempts: 0`) |
| IAM role `stale-flags-gha-publish` | GitHub Actions OIDC for `.github/workflows/publish-flags.yml` |

Surgeon runs inside CodeBuild and calls Bedrock Converse (`us.anthropic.claude-*` inference profile). It is not a zip Lambda.

## Commands

```bash
# From repo root (AWS credentials + region us-east-1)
pnpm infra:bootstrap   # once per account/region
pnpm infra:deploy
pnpm infra:secrets     # push .env tokens into Secrets Manager
pnpm infra:sync        # upload datafile + web build + CloudFront invalidation

# On-demand agent run in AWS (same as the nightly schedule)
pnpm infra:agent-run
```

After deploy, add GitHub repo secret `AWS_GHA_PUBLISH_ROLE_ARN` = stack output `GitHubPublishRoleArn` so `publish-flags.yml` can assume the OIDC role.

GitHub may emit OIDC `sub` as `repo:owner/repo:ref:…` or the ID form `repo:owner@id/repo@id:ref:…`. The role trust allows both. The GHA role also needs `cloudformation:DescribeStacks` on `StaleFlagsStack` to resolve bucket/distribution outputs.

If the account already has a GitHub OIDC provider, redeploy with:

```bash
pnpm --filter @stale-flags/infra exec cdk deploy -c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
```

## Cost (dev / demo)

Idle is typically a few USD/month (CloudFront + S3 + Secrets). CodeBuild and Bedrock only bill when the agent runs.
