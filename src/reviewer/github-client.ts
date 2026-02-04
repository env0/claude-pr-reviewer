import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Finding } from '../types/review.js';

const execFileAsync = promisify(execFile);

export type GitHubConfig = {
  appId: string;
  privateKey: string;
  installationId: number;
};

export type PullRequestInfo = {
  owner: string;
  repo: string;
  number: number;
  baseBranch: string;
  headBranch: string;
  headSha: string;
};

export type ExistingComment = {
  id: number;
  body: string;
  path: string;
  line: number;
  hash: string | null;
};

export type ReviewAction = 'request_changes' | 'comment' | 'approve';

const AI_REVIEW_METADATA_PATTERN = /<!-- ai-review: ({.*?}) -->/;
const LABEL_PENDING = 'ai-review-pending';
const LABEL_REVIEWED = 'ai-reviewed';

export function createGitHubClient(config: GitHubConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });
}

export async function getPullRequestInfo(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestInfo> {
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    owner,
    repo,
    number: prNumber,
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    headSha: pr.head.sha,
  };
}

export async function getExistingBotComments(
  octokit: Octokit,
  pr: PullRequestInfo
): Promise<ExistingComment[]> {
  const { data: comments } = await octokit.pulls.listReviewComments({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
  });

  const botComments: ExistingComment[] = [];

  for (const comment of comments) {
    const metadataMatch = comment.body?.match(AI_REVIEW_METADATA_PATTERN);
    if (metadataMatch) {
      try {
        const metadata = JSON.parse(metadataMatch[1]) as { hash?: string };
        botComments.push({
          id: comment.id,
          body: comment.body ?? '',
          path: comment.path,
          line: comment.line ?? comment.original_line ?? 0,
          hash: metadata.hash ?? null,
        });
      } catch {
        // Invalid metadata, skip
      }
    }
  }

  return botComments;
}

export async function createReviewComment(
  octokit: Octokit,
  pr: PullRequestInfo,
  finding: Finding,
  commentBody: string
): Promise<void> {
  await octokit.pulls.createReviewComment({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    commit_id: pr.headSha,
    path: finding.file,
    line: finding.endLine ?? finding.line,
    start_line: finding.endLine ? finding.line : undefined,
    body: commentBody,
  });
}

export async function resolveComment(
  octokit: Octokit,
  pr: PullRequestInfo,
  commentId: number
): Promise<void> {
  const { data: comment } = await octokit.pulls.getReviewComment({
    owner: pr.owner,
    repo: pr.repo,
    comment_id: commentId,
  });

  if (comment.in_reply_to_id) {
    return;
  }

  try {
    await octokit.graphql(
      `
      mutation ResolveThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            isResolved
          }
        }
      }
    `,
      {
        threadId: comment.node_id,
      }
    );
  } catch {
    // Thread resolution may not be available, skip
  }
}

export async function submitReview(
  octokit: Octokit,
  pr: PullRequestInfo,
  action: ReviewAction,
  body: string
): Promise<void> {
  if (action === 'approve') {
    await octokit.issues.createComment({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      body,
    });
  } else {
    const event = action === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    await octokit.pulls.createReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      event,
      body,
    });
  }
}

export async function dismissStaleReview(octokit: Octokit, pr: PullRequestInfo): Promise<void> {
  const { data: reviews } = await octokit.pulls.listReviews({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
  });

  const botRequestChangesReview = reviews.find(
    (r) => r.state === 'CHANGES_REQUESTED' && r.body?.includes('Claude PR Reviewer')
  );

  if (botRequestChangesReview) {
    await octokit.pulls.dismissReview({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.number,
      review_id: botRequestChangesReview.id,
      message: 'Issues have been addressed in subsequent commits.',
    });
  }
}

export async function setLabels(octokit: Octokit, pr: PullRequestInfo, pending: boolean): Promise<void> {
  const { data: issue } = await octokit.issues.get({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
  });

  const currentLabels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name ?? ''));

  const labelsToRemove = pending ? [LABEL_REVIEWED] : [LABEL_PENDING];
  const labelToAdd = pending ? LABEL_PENDING : LABEL_REVIEWED;

  for (const label of labelsToRemove) {
    if (currentLabels.includes(label)) {
      await octokit.issues.removeLabel({
        owner: pr.owner,
        repo: pr.repo,
        issue_number: pr.number,
        name: label,
      });
    }
  }

  if (!currentLabels.includes(labelToAdd)) {
    await octokit.issues.addLabels({
      owner: pr.owner,
      repo: pr.repo,
      issue_number: pr.number,
      labels: [labelToAdd],
    });
  }
}

export async function postErrorComment(
  octokit: Octokit,
  pr: PullRequestInfo,
  error: string
): Promise<void> {
  await octokit.issues.createComment({
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.number,
    body: `⚠️ **Claude PR Reviewer encountered an error**

${error}

Please re-request review to try again.

*Commit: ${pr.headSha.substring(0, 7)}*`,
  });
}

export async function cloneRepository(
  octokit: Octokit,
  pr: PullRequestInfo,
  targetPath: string
): Promise<string> {
  const token = (await octokit.auth({ type: 'installation' })) as { token: string };
  const cloneUrl = `https://x-access-token:${token.token}@github.com/${pr.owner}/${pr.repo}.git`;

  await execFileAsync('git', ['clone', '--depth=50', cloneUrl, targetPath]);
  await execFileAsync('git', ['fetch', 'origin', `${pr.headBranch}:${pr.headBranch}`], {
    cwd: targetPath,
  });
  await execFileAsync('git', ['checkout', pr.headBranch], { cwd: targetPath });

  return targetPath;
}

export async function getChangedFilesCount(octokit: Octokit, pr: PullRequestInfo): Promise<number> {
  const { data: prData } = await octokit.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
  });

  return prData.changed_files;
}

export async function isNonCodePR(octokit: Octokit, pr: PullRequestInfo): Promise<boolean> {
  const { data: files } = await octokit.pulls.listFiles({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const codeExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    '.scala',
    '.vue',
    '.svelte',
  ]);

  return !files.some((f) => {
    const ext = f.filename.substring(f.filename.lastIndexOf('.'));
    return codeExtensions.has(ext);
  });
}
