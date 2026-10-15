import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";

export interface AgentOrchestratorProps {
  agentSecrets: secretsmanager.ISecret;
  githubRepo: string;
}

export class AgentOrchestrator extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly resultsBucket: s3.Bucket;
  readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: AgentOrchestratorProps) {
    super(scope, id);

    const { agentSecrets, githubRepo } = props;
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

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
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const exclude = [
      "infra/cdk.out",
      "**/node_modules",
      "**/.local-data",
      "featurevisor/datafiles",
    ];

    const scoutImage = new ecrAssets.DockerImageAsset(this, "ScoutImage", {
      directory: path.join(__dirname, "../.."),
      file: "Dockerfile.scout",
      exclude,
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const surgeonImage = new ecrAssets.DockerImageAsset(this, "SurgeonImage", {
      directory: path.join(__dirname, "../.."),
      file: "Dockerfile.surgeon",
      exclude,
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const scoutLogs = new logs.LogGroup(this, "ScoutLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const surgeonLogs = new logs.LogGroup(this, "SurgeonLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const arm64 = {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    const scoutTask = new ecs.FargateTaskDefinition(this, "ScoutTask", {
      memoryLimitMiB: 2048,
      cpu: 1024,
      runtimePlatform: arm64,
    });
    agentSecrets.grantRead(scoutTask.taskRole);
    this.resultsBucket.grantReadWrite(scoutTask.taskRole);

    const scoutContainer = scoutTask.addContainer("scout", {
      image: ecs.ContainerImage.fromDockerImageAsset(scoutImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "scout",
        logGroup: scoutLogs,
      }),
      environment: {
        AWS_REGION: region,
        AWS_REGION_NAME: region,
        // Deterministic scout: Tinybird REST only (models/people use MCP).
        SCOUT_SOURCE: "tinybird",
        AGENT_ORCHESTRATOR: "stepfunctions",
        GITHUB_REPO: githubRepo,
      },
      secrets: {
        GITHUB_TOKEN: ecs.Secret.fromSecretsManager(agentSecrets, "GITHUB_TOKEN"),
        DEMO_BRANCH: ecs.Secret.fromSecretsManager(agentSecrets, "DEMO_BRANCH"),
        TINYBIRD_API_HOST: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_API_HOST",
        ),
        TINYBIRD_DECISION_TOKEN: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_DECISION_TOKEN",
        ),
        TINYBIRD_TOKEN: ecs.Secret.fromSecretsManager(agentSecrets, "TINYBIRD_TOKEN"),
      },
    });

    const surgeonTask = new ecs.FargateTaskDefinition(this, "SurgeonTask", {
      memoryLimitMiB: 4096,
      cpu: 2048,
      runtimePlatform: arm64,
    });
    agentSecrets.grantRead(surgeonTask.taskRole);
    this.resultsBucket.grantReadWrite(surgeonTask.taskRole);
    surgeonTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:GetInferenceProfile",
        ],
        resources: [
          `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-*`,
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        ],
      }),
    );

    const surgeonContainer = surgeonTask.addContainer("surgeon", {
      image: ecs.ContainerImage.fromDockerImageAsset(surgeonImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "surgeon",
        logGroup: surgeonLogs,
      }),
      environment: {
        AWS_REGION: region,
        AWS_REGION_NAME: region,
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
        TINYBIRD_DECISION_TOKEN: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_DECISION_TOKEN",
        ),
        TINYBIRD_TOKEN: ecs.Secret.fromSecretsManager(agentSecrets, "TINYBIRD_TOKEN"),
        // Read-only MCP token for evidence narrative (not reused for REST re-verify).
        TINYBIRD_MCP_TOKEN: ecs.Secret.fromSecretsManager(
          agentSecrets,
          "TINYBIRD_MCP_TOKEN",
        ),
      },
    });

    const stateMachineName = "stale-flags-cleanup";
    const stateMachineArn = `arn:aws:states:${region}:${account}:stateMachine:${stateMachineName}`;

    const planKey = sfn.JsonPath.format(
      "{}/plan.json",
      sfn.JsonPath.stringAt("$$.Execution.Name"),
    );
    const planUri = sfn.JsonPath.format(
      `s3://${this.resultsBucket.bucketName}/{}/plan.json`,
      sfn.JsonPath.stringAt("$$.Execution.Name"),
    );
    const surgeonResultKey = sfn.JsonPath.format(
      "{}/surgeon-result.json",
      sfn.JsonPath.stringAt("$$.Execution.Name"),
    );
    const surgeonResultUri = sfn.JsonPath.format(
      `s3://${this.resultsBucket.bucketName}/{}/surgeon-result.json`,
      sfn.JsonPath.stringAt("$$.Execution.Name"),
    );

    const alreadyRunning = new sfn.Succeed(this, "AlreadyRunning");

    const listRunning = new tasks.CallAwsService(this, "ListRunningExecutions", {
      service: "sfn",
      action: "listExecutions",
      parameters: {
        StateMachineArn: sfn.JsonPath.stringAt("$$.StateMachine.Id"),
        StatusFilter: "RUNNING",
        MaxResults: 10,
      },
      iamResources: [stateMachineArn],
      resultPath: "$.running",
    });

    const countRunning = new sfn.Pass(this, "CountRunning", {
      parameters: {
        "count.$": "States.ArrayLength($.running.Executions)",
        "running.$": "$.running",
      },
    });

    const scout = new tasks.EcsRunTask(this, "Scout", {
      cluster: this.cluster,
      taskDefinition: scoutTask,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: true,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: scoutContainer,
          environment: [{ name: "RESULT_S3_URI", value: planUri }],
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
        Key: planKey,
      },
      iamResources: [this.resultsBucket.arnForObjects("*")],
      resultSelector: { "body.$": "$.Body" },
      resultPath: "$.scoutRaw",
    });

    const parseScout = new sfn.Pass(this, "ParseScoutResult", {
      parameters: {
        "scout.$": "States.StringToJson($.scoutRaw.body)",
      },
    });

    const nothingToDo = new sfn.Succeed(this, "NothingToDo");

    const surgeon = new tasks.EcsRunTask(this, "Surgeon", {
      cluster: this.cluster,
      taskDefinition: surgeonTask,
      launchTarget: new tasks.EcsFargateLaunchTarget({
        platformVersion: ecs.FargatePlatformVersion.LATEST,
      }),
      assignPublicIp: true,
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      containerOverrides: [
        {
          containerDefinition: surgeonContainer,
          environment: [
            { name: "PLAN_S3_URI", value: planUri },
            { name: "RESULT_S3_URI", value: surgeonResultUri },
          ],
        },
      ],
      resultPath: sfn.JsonPath.DISCARD,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(50)),
    });

    const loadSurgeon = new tasks.CallAwsService(this, "LoadSurgeonResult", {
      service: "s3",
      action: "getObject",
      parameters: {
        Bucket: this.resultsBucket.bucketName,
        Key: surgeonResultKey,
      },
      iamResources: [this.resultsBucket.arnForObjects("*")],
      resultSelector: { "body.$": "$.Body" },
      resultPath: "$.surgeonRaw",
    });

    const parseSurgeon = new sfn.Pass(this, "ParseSurgeonResult", {
      parameters: {
        "scout.$": "$.scout",
        "result.$": "States.StringToJson($.surgeonRaw.body)",
      },
    });

    const surgeonFailed = new sfn.Fail(this, "SurgeonFailed", {
      error: "SurgeonFailed",
      cause: "Surgeon Fargate task failed or did not write a result",
    });

    const succeeded = new sfn.Succeed(this, "Succeeded");

    const surgeonChain = surgeon
      .addCatch(surgeonFailed, { errors: ["States.ALL"] })
      .next(
        loadSurgeon
          .addCatch(surgeonFailed, { errors: ["States.ALL"] })
          .next(parseSurgeon)
          .next(succeeded),
      );

    const hasCandidates = new sfn.Choice(this, "HasCandidates")
      .when(
        sfn.Condition.isPresent("$.scout.candidates[0]"),
        surgeonChain,
      )
      .otherwise(nothingToDo);

    const scoutChain = scout
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

    // RUNNING list always includes this execution; >1 means another is in flight.
    const overlapGate = listRunning.next(countRunning).next(
      new sfn.Choice(this, "OverlapCheck")
        .when(sfn.Condition.numberGreaterThan("$.count", 1), alreadyRunning)
        .otherwise(scoutChain),
    );

    this.stateMachine = new sfn.StateMachine(this, "StateMachine", {
      stateMachineName,
      definitionBody: sfn.DefinitionBody.fromChainable(overlapGate),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });

    this.resultsBucket.grantRead(this.stateMachine);

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    this.stateMachine.grantStartExecution(schedulerRole);

    new scheduler.Schedule(this, "NightlyAgent", {
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

    // Alert on failed / timed-out / aborted nights (silent success stays quiet).
    const alertEmail = cdk.Stack.of(this).node.tryGetContext("alertEmail") as
      | string
      | undefined;
    const alertTopic = new sns.Topic(this, "AgentFailureTopic", {
      topicName: "stale-flags-agent-failures",
      displayName: "Stale flags agent failures",
    });
    if (alertEmail) {
      alertTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alertEmail),
      );
    }

    new events.Rule(this, "AgentFailureRule", {
      description: "Notify when stale-flags-cleanup fails, times out, or aborts",
      eventPattern: {
        source: ["aws.states"],
        detailType: ["Step Functions Execution Status Change"],
        detail: {
          status: ["FAILED", "TIMED_OUT", "ABORTED"],
          stateMachineArn: [this.stateMachine.stateMachineArn],
        },
      },
      targets: [
        new eventsTargets.SnsTopic(alertTopic, {
          message: events.RuleTargetInput.fromObject({
            subject: "stale-flags-cleanup failed",
            executionArn: events.EventField.fromPath("$.detail.executionArn"),
            status: events.EventField.fromPath("$.detail.status"),
            stateMachineArn: events.EventField.fromPath(
              "$.detail.stateMachineArn",
            ),
            name: events.EventField.fromPath("$.detail.name"),
            stopDate: events.EventField.fromPath("$.detail.stopDate"),
            error: events.EventField.fromPath("$.detail.error"),
            cause: events.EventField.fromPath("$.detail.cause"),
          }),
        }),
      ],
    });
  }
}
