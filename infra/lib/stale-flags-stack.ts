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
export class StaleFlagsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubRepo =
      this.node.tryGetContext("githubRepo") ?? "lucamezzalira/stale-flag-cleanup";

    // --- Secrets (fill values after deploy; never commit them) ---
    const agentSecrets = new secretsmanager.Secret(this, "AgentSecrets", {
      secretName: "stale-flags/agent",
      description: "GitHub + Tinybird tokens for scheduled scout/surgeon",
      secretObjectValue: {
        GITHUB_TOKEN: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        GITHUB_REPO: cdk.SecretValue.unsafePlainText(githubRepo),
        DEMO_BRANCH: cdk.SecretValue.unsafePlainText("demo"),
        TINYBIRD_API_HOST: cdk.SecretValue.unsafePlainText(
          "https://api.us-east.aws.tinybird.co",
        ),
        TINYBIRD_APPEND_TOKEN: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        TINYBIRD_TOKEN: cdk.SecretValue.unsafePlainText("REPLACE_ME"),
        OLLAMA_DISABLED: cdk.SecretValue.unsafePlainText("1"),
      },
    });

    // --- Featurevisor datafiles ---
    const datafileBucket = new s3.Bucket(this, "DatafileBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const datafileOai = new cloudfront.OriginAccessIdentity(this, "DatafileOai");
    datafileBucket.grantRead(datafileOai);

    const datafileDist = new cloudfront.Distribution(this, "DatafileDistribution", {
      comment: "Featurevisor datafiles",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(datafileBucket, {
          originAccessIdentity: datafileOai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
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

    const webOai = new cloudfront.OriginAccessIdentity(this, "WebOai");
    webBucket.grantRead(webOai);

    const webDist = new cloudfront.Distribution(this, "WebDistribution", {
      comment: "Northline demo shop",
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessIdentity(webBucket, {
          originAccessIdentity: webOai,
        }),
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

    // Placeholder index so the distribution is not empty before first sync
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

    // --- Scheduled agent via CodeBuild (full monorepo + git/gh) ---
    const agentProject = new codebuild.Project(this, "AgentProject", {
      projectName: "stale-flags-agent",
      description: "Nightly scout/surgeon against demo branch",
      timeout: cdk.Duration.hours(1),
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
        AGENT_SECRET_ARN: { value: agentSecrets.secretArn },
        AWS_REGION_NAME: { value: this.region },
        REPO_URL: {
          value: `https://github.com/${githubRepo}.git`,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: "22" },
            commands: [
              "npm install -g pnpm@10",
              "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
              'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
              "apt-get update && apt-get install -y gh",
            ],
          },
          pre_build: {
            commands: [
              'export SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$AGENT_SECRET_ARN" --query SecretString --output text)',
              'export GITHUB_TOKEN=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\'])[\'GITHUB_TOKEN\'])")',
              'export GITHUB_REPO=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\'])[\'GITHUB_REPO\'])")',
              'export DEMO_BRANCH=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\']).get(\'DEMO_BRANCH\') or \'demo\')")',
              'export TINYBIRD_API_HOST=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\'])[\'TINYBIRD_API_HOST\'])")',
              'export TINYBIRD_APPEND_TOKEN=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\'])[\'TINYBIRD_APPEND_TOKEN\'])")',
              'export TINYBIRD_TOKEN=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\'])[\'TINYBIRD_TOKEN\'])")',
              'export OLLAMA_DISABLED=$(python3 -c "import json,os; print(json.loads(os.environ[\'SECRET_JSON\']).get(\'OLLAMA_DISABLED\') or \'1\')")',
              'export GH_TOKEN="$GITHUB_TOKEN"',
              'git clone --depth 1 "$REPO_URL" app',
              "cd app && pnpm install --frozen-lockfile",
              "cd app && pnpm seed",
            ],
          },
          build: {
            commands: ["cd app && OLLAMA_DISABLED=1 pnpm agent:run"],
          },
        },
      }),
    });

    agentSecrets.grantRead(agentProject);
    agentProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [agentSecrets.secretArn],
      }),
    );

    // Midnight UTC schedule (article capture). Also startable on demand.
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
      }),
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "WebUrl", {
      value: `https://${webDist.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new cdk.CfnOutput(this, "DatafileUrl", {
      value: `https://${datafileDist.distributionDomainName}/featurevisor`,
    });
    new cdk.CfnOutput(this, "DatafileBucketName", {
      value: datafileBucket.bucketName,
    });
    new cdk.CfnOutput(this, "DatafileCloudFrontDomain", {
      value: datafileDist.distributionDomainName,
    });
    new cdk.CfnOutput(this, "AgentSecretArn", {
      value: agentSecrets.secretArn,
    });
    new cdk.CfnOutput(this, "AgentProjectName", {
      value: agentProject.projectName,
    });
    new cdk.CfnOutput(this, "Region", { value: this.region });
  }
}
