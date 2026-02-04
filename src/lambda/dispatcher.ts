import { createHmac, timingSafeEqual } from 'crypto';
import {
  ECSClient,
  RunTaskCommand,
  type RunTaskCommandInput,
} from '@aws-sdk/client-ecs';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export type WebhookEvent = {
  headers: Record<string, string | undefined>;
  body: string;
};

export type DispatcherResponse = {
  statusCode: number;
  body: string;
};

export type DispatcherConfig = {
  webhookSecret: string;
  ecsCluster: string;
  ecsTaskDefinition: string;
  ecsSubnets: string[];
  ecsSecurityGroups: string[];
  containerName: string;
};

type IssueCommentPayload = {
  action: string;
  comment: {
    body: string;
  };
  issue: {
    number: number;
    pull_request?: {
      url: string;
    };
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
  installation?: {
    id: number;
  };
};

const ecsClient = new ECSClient({});
const secretsClient = new SecretsManagerClient({});

let cachedConfig: DispatcherConfig | null = null;

export async function handler(event: WebhookEvent): Promise<DispatcherResponse> {
  try {
    const config = await getConfig();

    const signature = event.headers['x-hub-signature-256'];
    if (!signature || !verifySignature(event.body, signature, config.webhookSecret)) {
      return { statusCode: 401, body: 'Invalid signature' };
    }

    const githubEvent = event.headers['x-github-event'];
    if (githubEvent !== 'issue_comment') {
      return { statusCode: 200, body: 'Ignoring non-comment event' };
    }

    const payload = JSON.parse(event.body) as IssueCommentPayload;

    if (!shouldTriggerReview(payload)) {
      return { statusCode: 200, body: 'No review needed for this comment' };
    }

    const installationId = payload.installation?.id;
    if (!installationId) {
      return { statusCode: 400, body: 'Missing installation ID' };
    }

    await spawnReviewTask(config, {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.issue.number,
      installationId,
    });

    return { statusCode: 202, body: 'Review task spawned' };
  } catch (err) {
    console.error('Dispatcher error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { statusCode: 500, body: message };
  }
}

function shouldTriggerReview(payload: IssueCommentPayload): boolean {
  if (payload.action !== 'created') {
    return false;
  }

  if (!payload.issue.pull_request) {
    return false;
  }

  const comment = payload.comment.body.trim();
  return comment === '/claude-review' || comment.startsWith('/claude-review ');
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

type ReviewTaskParams = {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
};

async function spawnReviewTask(config: DispatcherConfig, params: ReviewTaskParams): Promise<void> {
  const input: RunTaskCommandInput = {
    cluster: config.ecsCluster,
    taskDefinition: config.ecsTaskDefinition,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: config.ecsSubnets,
        securityGroups: config.ecsSecurityGroups,
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: config.containerName,
          environment: [
            { name: 'PR_OWNER', value: params.owner },
            { name: 'PR_REPO', value: params.repo },
            { name: 'PR_NUMBER', value: String(params.prNumber) },
            { name: 'GITHUB_INSTALLATION_ID', value: String(params.installationId) },
          ],
        },
      ],
    },
  };

  const command = new RunTaskCommand(input);
  await ecsClient.send(command);

  console.log(`Spawned review task for ${params.owner}/${params.repo}#${params.prNumber}`);
}

async function getConfig(): Promise<DispatcherConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const secretName = process.env.CONFIG_SECRET_NAME;
  if (!secretName) {
    throw new Error('CONFIG_SECRET_NAME environment variable not set');
  }

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  cachedConfig = JSON.parse(response.SecretString) as DispatcherConfig;
  return cachedConfig;
}

export { verifySignature, shouldTriggerReview };
