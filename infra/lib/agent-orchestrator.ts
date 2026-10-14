import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as sns from "aws-cdk-lib/aws-sns";

export interface AgentOrchestratorProps {
  agentSecrets: secretsmanager.ISecret;
  githubRepo: string;
}

export class AgentOrchestrator extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly resultsBucket: s3.Bucket;
  readonly cluster: ecs.Cluster;
  readonly notifyTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AgentOrchestratorProps) {
    super(scope, id);

    const { agentSecrets, githubRepo } = props;

    this.resultsBucket = new s3.Bucket(this, "ResultsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }],
    });

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "stale-flags-agent",
      vpc,
      containerInsights: false,
    });

    const image = new ecrAssets.DockerImageAsset(this, "AgentImage", {
      directory: path.join(__dirname, "../.."),
      file: "Dockerfile",
      exclude: [
        "infra/cdk.out",
        "**/node_modules",
        "**/.local-data",
        "featurevisor/datafiles",
      ],
    });

    const logGroup = new logs.LogGroup(this, "TaskLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      memoryLimitMiB: 4096,
      cpu: 2048,
      // Image is built on Apple Silicon locally; pin ARM64 so Fargate matches.
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    agentSecrets.grantRead(taskDef.taskRole);
    this.resultsBucket.grantReadWrite(taskDef.taskRole);
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:GetInferenceProfile",
        ],
        resources: [
          `arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/us.anthropic.claude-*`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        ],
      }),
    );

    const container = taskDef.addContainer("agent", {
      image: ecs.ContainerImage.fromDockerImageAsset(image),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "agent",
        logGroup,
      }),
      environment: {
        AWS_REGION: cdk.Stack.of(this).region,
        AWS_REGION_NAME: cdk.Stack.of(this).region,
        SCOUT_SOURCE: "tinybird",
        AGENT_ORCHESTRATOR: "stepfunctions",
        BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        BEDROCK_DISABLED: "0",
        GITHUB_REPO: githubRepo,
      },
      secrets: {
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(agentSecrets, "GITHUB_TOKEN"),
        DEMO_BRANCH: ecs.Secret.fromSecretsManager(agentSecrets, "DEMO_BRANCH"),
        TINYBIRD_API_HOST: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_API_HOST",
        ),
        TINYBIRD_APPEND_TOKEN: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_APPEND_TOKEN",
        ),
        TINYBIRD_TOKEN: ecs.Secret.fromSecretsManager(agentSecrets, "TINYBIRD_TOKEN"),
      },
    });

    this.notifyTopic = new sns.Topic(this, "MergeGateTopic", {
      topicName: "stale-flags-merge-gate",
      displayName: "Stale flag cleanup merge gate",
    });

    const scout = new tasks.EcsRunTask(this, "Scout", {
      cluster: this.cluster,
      taskDefinition: taskDef,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: true,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: container,
          environment: [
            { name: "AGENT_ROLE", value: "scout" },
            {
              name: "RESULT_S3_URI",
              value: sfn.JsonPath.format(
                `s3://${this.resultsBucket.bucketName}/{}/scout.json`,
                sfn.JsonPath.stringAt("$$.Execution.Name"),
              ),
            },
          ],
        },
      ],
      resultPath: sfn.JsonPath.DISCARD,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(15)),
    });

    const loadScout = new tasks.CallAwsService(this, "LoadScoutResult", {
      service: "s3",
      action: "getObject",
      parameters: {
        Bucket: this.resultsBucket.bucketName,
        Key: sfn.JsonPath.format(
          "{}/scout.json",
          sfn.JsonPath.stringAt("$$.Execution.Name"),
        ),
      },
      iamResources: [this.resultsBucket.arnForObjects("*")],
      resultSelector: {
        "body.$": "$.Body",
      },
      resultPath: "$.scoutRaw",
    });

    // CallAwsService s3:getObject returns Body as a UTF-8 string in ASL
    // (not base64). Base64Decode corrupts the JSON.
    const parseScout = new sfn.Pass(this, "ParseScoutResult", {
      parameters: {
        "scout.$": "States.StringToJson($.scoutRaw.body)",
      },
    });

    const nothingToDo = new sfn.Succeed(this, "NothingToDo");

    const surgeon = new tasks.EcsRunTask(this, "Surgeon", {
      cluster: this.cluster,
      taskDefinition: taskDef,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: true,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: container,
          environment: [
            { name: "AGENT_ROLE", value: "surgeon" },
            {
              name: "FLAG_KEY",
              value: sfn.JsonPath.stringAt("$.flag_key"),
            },
            {
              name: "SURGEON_PAYLOAD_B64",
              value: sfn.JsonPath.stringAt("$.payload_b64"),
            },
            {
              name: "RESULT_S3_URI",
              value: sfn.JsonPath.format(
                `s3://${this.resultsBucket.bucketName}/{}/surgeon-{}.json`,
                sfn.JsonPath.stringAt("$$.Execution.Name"),
                sfn.JsonPath.stringAt("$.flag_key"),
              ),
            },
          ],
        },
      ],
      resultPath: sfn.JsonPath.DISCARD,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(25)),
    });

    const loadSurgeon = new tasks.CallAwsService(this, "LoadSurgeonResult", {
      service: "s3",
      action: "getObject",
      parameters: {
        Bucket: this.resultsBucket.bucketName,
        Key: sfn.JsonPath.format(
          "{}/surgeon-{}.json",
          sfn.JsonPath.stringAt("$$.Execution.Name"),
          sfn.JsonPath.stringAt("$.flag_key"),
        ),
      },
      iamResources: [this.resultsBucket.arnForObjects("*")],
      resultSelector: {
        "body.$": "$.Body",
      },
      resultPath: "$.surgeonRaw",
    });

    const parseSurgeon = new sfn.Pass(this, "ParseSurgeonResult", {
      parameters: {
        "result.$": "States.StringToJson($.surgeonRaw.body)",
      },
      outputPath: "$.result",
    });

    const surgeonFailed = new sfn.Pass(this, "SurgeonFailed", {
      parameters: {
        "flag_key.$": "$.flag_key",
        ok: false,
        pr_url: "",
        "error.$": "$.error.Error",
      },
    });

    const surgeonChain = surgeon
      .addCatch(surgeonFailed, {
        errors: ["States.ALL"],
        resultPath: "$.error",
      })
      .next(
        loadSurgeon
          .addCatch(surgeonFailed, {
            errors: ["States.ALL"],
            resultPath: "$.error",
          })
          .next(parseSurgeon),
      );

    const removeFlags = new sfn.Map(this, "RemoveFlags", {
      itemsPath: sfn.JsonPath.stringAt("$.scout.candidates"),
      maxConcurrency: 1,
      resultPath: "$.prs",
    });
    removeFlags.itemProcessor(surgeonChain);

    const notify = new tasks.SnsPublish(this, "NotifyMergeGate", {
      topic: this.notifyTopic,
      message: sfn.TaskInput.fromObject({
        notice: "Merge gate: review and merge agent PRs into demo",
        "run_id.$": "$.scout.run_id",
        "prs.$": "$.prs",
        "execution.$": "$$.Execution.Id",
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const succeeded = new sfn.Succeed(this, "Succeeded");

    const hasCandidates = new sfn.Choice(this, "HasCandidates")
      .when(
        sfn.Condition.isPresent("$.scout.candidates[0]"),
        removeFlags.next(notify).next(succeeded),
      )
      .otherwise(nothingToDo);

    const definition = scout
      .addCatch(
        new sfn.Fail(this, "ScoutFailed", {
          error: "ScoutFailed",
          cause: "Scout Fargate task failed",
        }),
        { errors: ["States.ALL"] },
      )
      .next(loadScout)
      .next(parseScout)
      .next(hasCandidates);

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName: "stale-flags-cleanup",
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(1),
      tracingEnabled: true,
    });

    this.resultsBucket.grantRead(this.stateMachine);
    this.notifyTopic.grantPublish(this.stateMachine);

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    this.stateMachine.grantStartExecution(schedulerRole);

    new scheduler.Schedule(this, "NightlyAgent", {
      // New physical name so the deploy can create this while the old
      // CodeBuild-targeted schedule (stale-flags-nightly-utc) is deleted.
      scheduleName: "stale-flags-sfn-nightly-utc",
      description: "Start stale-flag Step Functions cleanup at midnight UTC",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0",
        hour: "0",
        day: "*",
        month: "*",
        year: "*",
      }),
      target: new schedulerTargets.StepFunctionsStartExecution(
        this.stateMachine,
        {
          role: schedulerRole,
          input: scheduler.ScheduleTargetInput.fromObject({}),
          retryAttempts: 0,
        },
      ),
    });
  }
}
