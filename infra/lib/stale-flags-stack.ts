import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as iamOidc from "aws-cdk-lib/aws-iam";
import { AgentOrchestrator } from "./agent-orchestrator";

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
          // TINYBIRD_MCP_TOKEN is written only by put-secrets.sh. Do not add
          // keys here after first create; CFN regenerates the secret string.
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

    // --- Agent: Step Functions + ECS Fargate ---
    const agent = new AgentOrchestrator(this, "Agent", {
      agentSecrets,
      githubRepo,
    });

    // --- GitHub Actions OIDC for publish-flags.yml ---
    // Prefer an existing account OIDC provider ARN via context to avoid the
    // account-global EntityAlreadyExists collision on token.actions.githubusercontent.com.
    // If creating one, use current GitHub Actions CA thumbprints.
    const existingOidcArn = this.node.tryGetContext(
      "githubOidcProviderArn",
    ) as string | undefined;
    const githubProviderArn =
      existingOidcArn ??
      new iamOidc.OpenIdConnectProvider(this, "GitHubOidc", {
        url: "https://token.actions.githubusercontent.com",
        clientIds: ["sts.amazonaws.com"],
        thumbprints: [
          "6938fd4d98bab03faadb97b34396831e3780aea1",
          "1c58a3a8518e8759bf075b76b750d4f5df17b295",
        ],
      }).openIdConnectProviderArn;

    const ghaPublishRole = new iam.Role(this, "GitHubPublishRole", {
      roleName: "stale-flags-gha-publish",
      assumedBy: new iam.FederatedPrincipal(
        githubProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          // GitHub may emit classic sub (owner/repo) or ID-qualified
          // sub (owner@id/repo@id). Allow both for this repo.
          StringLike: {
            "token.actions.githubusercontent.com:sub": [
              `repo:${githubRepo}:*`,
              `repo:${String(githubRepo).replace("/", "@*/")}@*:*`,
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
    ghaPublishRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:DescribeStacks",
          "cloudformation:ListStackResources",
        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${cdk.Stack.of(this).stackName}/*`,
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
    new cdk.CfnOutput(this, "AgentStateMachineArn", {
      value: agent.stateMachine.stateMachineArn,
    });
    new cdk.CfnOutput(this, "AgentResultsBucketName", {
      value: agent.resultsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "GitHubPublishRoleArn", {
      value: ghaPublishRole.roleArn,
    });
    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
