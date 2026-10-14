import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iamOidc from "aws-cdk-lib/aws-iam";

export class StaleFlagsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubRepo =
      this.node.tryGetContext("githubRepo") ?? "lucamezzalira/stale-flag-cleanup";

    // Initial placeholder only on create. Never set secretObjectValue — that
    // overwrites live tokens on every cdk deploy. put-secrets.sh is the writer.
    const agentSecrets = new secretsmanager.Secret(this, "AgentSecrets", {
      secretName: "stale-flags/agent",
      description: "GitHub + Tinybird tokens for scheduled scout/surgeon",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          GITHUB_TOKEN: "REPLACE_ME",
          GITHUB_REPO: githubRepo,
          DEMO_BRANCH: "demo",
          TINYBIRD_API_HOST: "https://api.us-east.aws.tinybird.co",
          TINYBIRD_APPEND_TOKEN: "REPLACE_ME",
          TINYBIRD_TOKEN: "REPLACE_ME",
        }),
        generateStringKey: "_cdk_placeholder",
      },
    });

    // --- Featurevisor datafiles ---
    const datafileBucket = new s3.Bucket(this, "DatafileBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    const datafileCors = new cloudfront.ResponseHeadersPolicy(this, "DatafileCors", {
      comment: "Allow SPA to fetch Featurevisor datafiles",
      corsBehavior: {
        accessControlAllowOrigins: ["*"],
        accessControlAllowHeaders: ["*"],
        accessControlAllowMethods: ["GET", "HEAD", "OPTIONS"],
        accessControlAllowCredentials: false,
        originOverride: true,
      },
    });

    const datafileCachePolicy = new cloudfront.CachePolicy(this, "DatafileCache", {
      comment: "Short TTL for feature flag datafiles",
      defaultTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(60),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const datafileDist = new cloudfront.Distribution(this, "DatafileDistribution", {
      comment: "Featurevisor datafiles",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(datafileBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: datafileCachePolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        responseHeadersPolicy: datafileCors,
      },
    });

    // --- Demo web app (SPA) ---
    const webBucket = new s3.Bucket(this, "WebBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const webDist = new cloudfront.Distribution(this, "WebDistribution", {
      comment: "Northline demo shop",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(1),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(1),
        },
      ],
    });

    new s3deploy.BucketDeployment(this, "WebPlaceholder", {
      sources: [
        s3deploy.Source.data(
          "index.html",
          "<!doctype html><html><body><p>Deploying Northline… run pnpm infra:sync-web</p></body></html>",
        ),
      ],
      destinationBucket: webBucket,
      distribution: webDist,
      distributionPaths: ["/*"],
    });

    // --- Scheduled agent via CodeBuild (git/pnpm/rg/Bedrock Converse) ---
    const agentProject = new codebuild.Project(this, "AgentProject", {
      projectName: "stale-flags-agent",
      description: "Nightly scout/surgeon against demo branch",
      timeout: cdk.Duration.hours(1),
      queuedTimeout: cdk.Duration.hours(2),
      concurrentBuildLimit: 1,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: false,
      },
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "AgentLogs", {
            retention: logs.RetentionDays.TWO_WEEKS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
      environmentVariables: {
        AWS_REGION_NAME: { value: this.region },
        REPO_URL: { value: `https://github.com/${githubRepo}.git` },
        SCOUT_SOURCE: { value: "tinybird" },
        BEDROCK_MODEL_ID: {
          value: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        },
        GITHUB_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:GITHUB_TOKEN`,
        },
        GITHUB_REPO: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:GITHUB_REPO`,
        },
        DEMO_BRANCH: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:DEMO_BRANCH`,
        },
        TINYBIRD_API_HOST: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:TINYBIRD_API_HOST`,
        },
        TINYBIRD_APPEND_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:TINYBIRD_APPEND_TOKEN`,
        },
        TINYBIRD_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${agentSecrets.secretArn}:TINYBIRD_TOKEN`,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: "24" },
            commands: [
              "npm install -g pnpm@10",
              "apt-get update && apt-get install -y ripgrep",
              'command -v gh >/dev/null || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh)',
            ],
          },
          // Clone + install + agent in one BUILD command. CodeBuild may not
          // keep a PRE_BUILD checkout visible to BUILD (empty primary source),
          // and /bin/sh rejects pipefail — use set -eu only.
          build: {
            commands: [
              [
                "set -eu",
                'export GH_TOKEN="$GITHUB_TOKEN"',
                "gh auth setup-git",
                "rm -rf app",
                'git clone --depth 50 --branch "$DEMO_BRANCH" "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" app',
                "cd app",
                'echo "branch=$(git rev-parse --abbrev-ref HEAD)"',
                "git log -1 --oneline",
                "pnpm install --frozen-lockfile",
                // Workspace packages export dist/; CI has no local build cache.
                // flag-client is required for apps/web tsc/vite gates in the surgeon.
                "pnpm --filter @stale-flags/defs-utils --filter @stale-flags/verdicts --filter @stale-flags/local-store --filter @stale-flags/flag-client run build",
                "SCOUT_SOURCE=tinybird BEDROCK_DISABLED=0 pnpm agent:run",
              ].join("\n"),
            ],
          },
        },
      }),
    });

    agentSecrets.grantRead(agentProject);

    agentProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:GetInferenceProfile",
        ],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-*`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        ],
      }),
    );

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:StartBuild"],
        resources: [agentProject.projectArn],
      }),
    );

    new scheduler.Schedule(this, "NightlyAgent", {
      scheduleName: "stale-flags-nightly-utc",
      description: "Run stale-flag scout/surgeon at midnight UTC",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "0",
        day: "*",
        month: "*",
        year: "*",
      }),
      target: new schedulerTargets.CodeBuildStartBuild(agentProject, {
        role: schedulerRole,
        retryAttempts: 0,
      }),
    });

    // --- GitHub Actions OIDC for publish-flags.yml ---
    // Prefer an existing account OIDC provider ARN via context to avoid the
    // account-global EntityAlreadyExists collision on token.actions.githubusercontent.com.
    const existingOidcArn = this.node.tryGetContext(
      "githubOidcProviderArn",
    ) as string | undefined;
    const githubProviderArn =
      existingOidcArn ??
      new iamOidc.OpenIdConnectProvider(this, "GitHubOidc", {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
      }).openIdConnectProviderArn;

    const ghaPublishRole = new iam.Role(this, "GitHubPublishRole", {
      roleName: "stale-flags-gha-publish",
      assumedBy: new iam.FederatedPrincipal(
        githubProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": [
              `repo:${githubRepo}:ref:refs/heads/main`,
              `repo:${githubRepo}:ref:refs/heads/demo`,
            ],
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      description: "GitHub Actions role for datafile + web sync",
    });

    datafileBucket.grantReadWrite(ghaPublishRole);
    webBucket.grantReadWrite(ghaPublishRole);
    ghaPublishRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${datafileDist.distributionId}`,
          `arn:aws:cloudfront::${this.account}:distribution/${webDist.distributionId}`,
        ],
      }),
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, "WebUrl", {
      value: `https://${webDist.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new cdk.CfnOutput(this, "WebDistributionId", {
      value: webDist.distributionId,
    });
    new cdk.CfnOutput(this, "DatafileUrl", {
      value: `https://${datafileDist.distributionDomainName}/featurevisor`,
    });
    new cdk.CfnOutput(this, "DatafileBucketName", {
      value: datafileBucket.bucketName,
    });
    new cdk.CfnOutput(this, "DatafileCloudFrontDomain", {
      value: datafileDist.distributionDomainName,
    });
    new cdk.CfnOutput(this, "DatafileDistributionId", {
      value: datafileDist.distributionId,
    });
    new cdk.CfnOutput(this, "AgentSecretArn", {
      value: agentSecrets.secretArn,
    });
    new cdk.CfnOutput(this, "AgentProjectName", {
      value: agentProject.projectName,
    });
    new cdk.CfnOutput(this, "GitHubPublishRoleArn", {
      value: ghaPublishRole.roleArn,
    });
    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
