import { runReview, type ReviewerConfig } from './reviewer/index.js';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

type GitHubAppSecrets = {
  appId: string;
  privateKey: string;
};

const secretsClient = new SecretsManagerClient({});

async function main(): Promise<void> {
  const owner = process.env.PR_OWNER;
  const repo = process.env.PR_REPO;
  const prNumber = process.env.PR_NUMBER;
  const installationId = process.env.GITHUB_INSTALLATION_ID;

  if (!owner || !repo || !prNumber || !installationId) {
    console.error('Missing required environment variables');
    console.error('Required: PR_OWNER, PR_REPO, PR_NUMBER, GITHUB_INSTALLATION_ID');
    process.exit(1);
  }

  console.log(`Starting review for ${owner}/${repo}#${prNumber}`);

  const githubSecrets = await getGitHubAppSecrets();

  const config: ReviewerConfig = {
    github: {
      appId: githubSecrets.appId,
      privateKey: githubSecrets.privateKey,
      installationId: parseInt(installationId, 10),
    },
    maxFilesThreshold: parseInt(process.env.MAX_FILES_THRESHOLD ?? '100', 10),
    retryOnError: process.env.RETRY_ON_ERROR !== 'false',
  };

  const outcome = await runReview(config, {
    owner,
    repo,
    prNumber: parseInt(prNumber, 10),
  });

  console.log('Review outcome:', JSON.stringify(outcome, null, 2));

  if (!outcome.success) {
    process.exit(1);
  }
}

async function getGitHubAppSecrets(): Promise<GitHubAppSecrets> {
  const secretName = process.env.GITHUB_APP_SECRET_NAME ?? 'claude-pr-reviewer/github-app';

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('GitHub App secret is empty');
  }

  const secrets = JSON.parse(response.SecretString) as GitHubAppSecrets;

  if (!secrets.appId || !secrets.privateKey) {
    throw new Error('GitHub App secret missing appId or privateKey');
  }

  return secrets;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
