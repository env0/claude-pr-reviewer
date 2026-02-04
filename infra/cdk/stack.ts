import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export type ClaudePrReviewerStackProps = cdk.StackProps & {
  vpcId?: string;
};

export class ClaudePrReviewerStack extends cdk.Stack {
  public readonly webhookUrl: cdk.CfnOutput;
  public readonly ecrRepositoryUri: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props?: ClaudePrReviewerStackProps) {
    super(scope, id, props);

    const vpc = props?.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId })
      : new ec2.Vpc(this, 'Vpc', {
          maxAzs: 2,
          natGateways: 1,
        });

    const configSecret = new secretsmanager.Secret(this, 'ConfigSecret', {
      secretName: 'claude-pr-reviewer/config',
      description: 'Configuration for Claude PR Reviewer',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          webhookSecret: '',
          ecsCluster: '',
          ecsTaskDefinition: '',
          ecsSubnets: [],
          ecsSecurityGroups: [],
          containerName: 'reviewer',
        }),
        generateStringKey: 'placeholder',
      },
    });

    const githubAppSecret = new secretsmanager.Secret(this, 'GitHubAppSecret', {
      secretName: 'claude-pr-reviewer/github-app',
      description: 'GitHub App credentials',
    });

    const anthropicSecret = new secretsmanager.Secret(this, 'AnthropicSecret', {
      secretName: 'claude-pr-reviewer/anthropic',
      description: 'Anthropic API key',
    });

    const ecrRepository = new ecr.Repository(this, 'ReviewerRepository', {
      repositoryName: 'claude-pr-reviewer',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only 10 images',
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'claude-pr-reviewer',
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    githubAppSecret.grantRead(taskRole);
    anthropicSecret.grantRead(taskRole);

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    ecrRepository.grantPull(executionRole);
    githubAppSecret.grantRead(executionRole);
    anthropicSecret.grantRead(executionRole);

    const logGroup = new logs.LogGroup(this, 'TaskLogGroup', {
      logGroupName: '/ecs/claude-pr-reviewer',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: 4096,
      cpu: 2048,
      taskRole,
      executionRole,
      ephemeralStorageGiB: 21,
    });

    taskDefinition.addContainer('reviewer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'reviewer',
        logGroup,
      }),
      environment: {
        NODE_ENV: 'production',
      },
      secrets: {
        GITHUB_APP_ID: ecs.Secret.fromSecretsManager(githubAppSecret, 'appId'),
        GITHUB_APP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(githubAppSecret, 'privateKey'),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicSecret, 'apiKey'),
      },
    });

    const securityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      description: 'Security group for Claude PR Reviewer tasks',
      allowAllOutbound: true,
    });

    const dispatcherLambda = new lambda.Function(this, 'Dispatcher', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../dist/lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        CONFIG_SECRET_NAME: configSecret.secretName,
      },
    });

    configSecret.grantRead(dispatcherLambda);

    dispatcherLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [taskDefinition.taskDefinitionArn],
      })
    );

    dispatcherLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [taskRole.roleArn, executionRole.roleArn],
      })
    );

    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: 'Claude PR Reviewer Webhook',
      description: 'Receives GitHub webhooks for PR review',
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod('POST', new apigateway.LambdaIntegration(dispatcherLambda));

    const privateSubnetIds = vpc.privateSubnets.map((s) => s.subnetId);

    new cdk.CfnOutput(this, 'ConfigSecretArn', {
      value: configSecret.secretArn,
      description: 'ARN of the config secret - update with actual values',
    });

    new cdk.CfnOutput(this, 'ConfigSecretUpdateCommand', {
      value: `aws secretsmanager put-secret-value --secret-id ${configSecret.secretName} --secret-string '${JSON.stringify({
        webhookSecret: '<YOUR_WEBHOOK_SECRET>',
        ecsCluster: cluster.clusterArn,
        ecsTaskDefinition: taskDefinition.taskDefinitionArn,
        ecsSubnets: privateSubnetIds,
        ecsSecurityGroups: [securityGroup.securityGroupId],
        containerName: 'reviewer',
      })}'`,
      description: 'Command to update config secret with actual values',
    });

    this.webhookUrl = new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'GitHub webhook URL',
    });

    this.ecrRepositoryUri = new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR repository URI for pushing images',
    });

    new cdk.CfnOutput(this, 'GitHubAppSecretArn', {
      value: githubAppSecret.secretArn,
      description: 'ARN of GitHub App secret - populate with appId and privateKey',
    });

    new cdk.CfnOutput(this, 'AnthropicSecretArn', {
      value: anthropicSecret.secretArn,
      description: 'ARN of Anthropic secret - populate with apiKey',
    });
  }
}
