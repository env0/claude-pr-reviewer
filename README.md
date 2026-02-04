# Claude PR Reviewer

A GitHub App that automatically reviews pull requests using Claude AI.

## Features

- **Automated PR Reviews**: Triggered when requested as a reviewer
- **Severity Classification**: Critical, High, Medium, Low findings
- **Smart Blocking**: Only critical issues block PRs
- **Re-review Support**: Tracks fixed issues across reviews
- **GitHub Suggestions**: Uses native suggestion blocks for fixes

## Architecture

```
GitHub Webhook → API Gateway → Lambda → ECS Fargate (Claude CLI)
                                              ↓
                                        GitHub API
```

## Setup

### Prerequisites

- AWS Account with CDK bootstrapped
- GitHub organization admin access
- Anthropic API key

### 1. Deploy Infrastructure

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Deploy to AWS
pnpm cdk:deploy
```

### 2. Create GitHub App

1. Go to your GitHub organization settings
2. Navigate to Developer settings → GitHub Apps
3. Click "New GitHub App"
4. Configure:
   - **Name**: Claude PR Reviewer
   - **Homepage URL**: Your organization URL
   - **Webhook URL**: Use the `WebhookUrl` output from CDK
   - **Webhook secret**: Generate a secure secret
   - **Permissions**:
     - Pull requests: Read & Write
     - Contents: Read
     - Metadata: Read
   - **Events**:
     - Pull request
     - Pull request review

5. After creation, note the App ID and generate a private key

### 3. Configure Secrets

Update the AWS Secrets Manager secrets with your values:

```bash
# GitHub App credentials
aws secretsmanager put-secret-value \
  --secret-id claude-pr-reviewer/github-app \
  --secret-string '{"appId":"YOUR_APP_ID","privateKey":"YOUR_PRIVATE_KEY"}'

# Anthropic API key
aws secretsmanager put-secret-value \
  --secret-id claude-pr-reviewer/anthropic \
  --secret-string '{"apiKey":"YOUR_ANTHROPIC_API_KEY"}'

# Config (use the command from CDK output)
aws secretsmanager put-secret-value \
  --secret-id claude-pr-reviewer/config \
  --secret-string '{"webhookSecret":"YOUR_WEBHOOK_SECRET",...}'
```

### 4. Build and Push Docker Image

```bash
# Get ECR login
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin YOUR_ACCOUNT.dkr.ecr.us-east-1.amazonaws.com

# Build image
docker build -t claude-pr-reviewer .

# Tag and push
docker tag claude-pr-reviewer:latest YOUR_ECR_URI:latest
docker push YOUR_ECR_URI:latest
```

### 5. Install GitHub App

1. Go to your GitHub App settings
2. Click "Install App"
3. Select the repositories to enable

## Usage

### Trigger a Review

Request the bot as a reviewer on any PR:

1. Open a PR
2. Click "Reviewers" in the sidebar
3. Select your Claude PR Reviewer app

### Labels

| Label | Meaning |
|-------|---------|
| `ai-review-pending` | Review in progress |
| `ai-reviewed` | Review complete |

### Review Actions

| Findings | GitHub Action |
|----------|---------------|
| Any Critical | Request Changes |
| High only | Comment |
| Medium/Low only | Approval comment |

## Comment Format

Each finding is posted as a PR review comment with:

- Severity indicator (🔴 Critical, 🟠 High, 🟡 Medium, 🔵 Low)
- Category (Security, Performance, Logic, etc.)
- Description and fix suggestion
- Confidence level and reasoning
- References when applicable

## Configuration

Environment variables for the Fargate task:

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_FILES_THRESHOLD` | Skip PRs with more files | 100 |
| `RETRY_ON_ERROR` | Retry once on failure | true |

## Development

```bash
# Install dependencies
pnpm install

# Run type checking
pnpm typecheck

# Run tests
pnpm test

# Lint code
pnpm lint

# Format code
pnpm format
```

## License

MIT
