import { tmpdir } from 'os';
import { join } from 'path';
import { rm, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { Octokit } from '@octokit/rest';

import { runClaudeReview, checkClaudeCliAvailable } from './cli-runner.js';
import {
  createGitHubClient,
  getPullRequestInfo,
  getExistingBotComments,
  createReviewComment,
  resolveComment,
  submitReview,
  dismissStaleReview,
  setLabels,
  postErrorComment,
  cloneRepository,
  getChangedFilesCount,
  isNonCodePR,
  type GitHubConfig,
  type PullRequestInfo,
} from './github-client.js';
import {
  buildFindingComment,
  buildReviewSummary,
  buildSkipComment,
  sortFindingsBySeverity,
} from './comment-builder.js';
import { reconcileFindings, shouldDismissPreviousReview } from './reconciler.js';
import { determineReviewAction } from '../types/review.js';

export type ReviewerConfig = {
  github: GitHubConfig;
  maxFilesThreshold: number;
  retryOnError: boolean;
};

export type ReviewRequest = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type ReviewOutcome = {
  success: boolean;
  action?: 'reviewed' | 'skipped' | 'error';
  message: string;
  findingsCount?: number;
};

const MAX_FILES_DEFAULT = 100;

export async function runReview(
  config: ReviewerConfig,
  request: ReviewRequest
): Promise<ReviewOutcome> {
  const octokit = createGitHubClient(config.github);

  let pr: PullRequestInfo;
  try {
    pr = await getPullRequestInfo(octokit, request.owner, request.repo, request.prNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, action: 'error', message: `Failed to get PR info: ${message}` };
  }

  await setLabels(octokit, pr, true);

  try {
    const outcome = await performReview(octokit, config, pr);
    await setLabels(octokit, pr, false);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    if (config.retryOnError) {
      console.log('Retrying review after error...');
      try {
        const outcome = await performReview(octokit, config, pr);
        await setLabels(octokit, pr, false);
        return outcome;
      } catch (retryErr) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : 'Unknown error';
        await postErrorComment(octokit, pr, retryMessage);
        await setLabels(octokit, pr, false);
        return { success: false, action: 'error', message: retryMessage };
      }
    }

    await postErrorComment(octokit, pr, message);
    await setLabels(octokit, pr, false);
    return { success: false, action: 'error', message };
  }
}

async function performReview(
  octokit: Octokit,
  config: ReviewerConfig,
  pr: PullRequestInfo
): Promise<ReviewOutcome> {
  const cliAvailable = await checkClaudeCliAvailable();
  if (!cliAvailable) {
    throw new Error('Claude CLI is not available');
  }

  const changedFiles = await getChangedFilesCount(octokit, pr);
  const maxFiles = config.maxFilesThreshold ?? MAX_FILES_DEFAULT;

  if (changedFiles > maxFiles) {
    const reason = `This PR changes ${changedFiles} files, which exceeds the threshold of ${maxFiles} files. Please request a manual review.`;
    await submitReview(octokit, pr, 'comment', buildSkipComment(reason, pr.headSha));
    return { success: true, action: 'skipped', message: reason };
  }

  const nonCode = await isNonCodePR(octokit, pr);
  if (nonCode) {
    const reason =
      'This PR contains only non-code changes (documentation, configuration, etc.). Skipping detailed code review.';
    await submitReview(octokit, pr, 'comment', buildSkipComment(reason, pr.headSha));
    return { success: true, action: 'skipped', message: reason };
  }

  const workDir = join(tmpdir(), `pr-review-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    await cloneRepository(octokit, pr, workDir);

    const cliResult = await runClaudeReview({
      repoPath: workDir,
      prNumber: pr.number,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
    });

    if (!cliResult.success || !cliResult.result) {
      throw new Error(cliResult.error ?? 'Review failed with no output');
    }

    const result = cliResult.result;

    if (result.status === 'skipped') {
      await submitReview(
        octokit,
        pr,
        'comment',
        buildSkipComment(result.summary, pr.headSha)
      );
      return { success: true, action: 'skipped', message: result.summary };
    }

    const existingComments = await getExistingBotComments(octokit, pr);
    const reconciliation = reconcileFindings(result.findings, existingComments);

    for (const commentId of reconciliation.fixedCommentIds) {
      await resolveComment(octokit, pr, commentId);
    }

    const sortedFindings = sortFindingsBySeverity(reconciliation.newFindings);
    for (const finding of sortedFindings) {
      const commentBody = buildFindingComment(finding, pr.headSha);
      await createReviewComment(octokit, pr, finding, commentBody);
    }

    const action = determineReviewAction(result.findings);
    const summaryBody = buildReviewSummary(result, pr.headSha);

    if (shouldDismissPreviousReview(result.findings)) {
      await dismissStaleReview(octokit, pr);
    }

    await submitReview(octokit, pr, action, summaryBody);

    return {
      success: true,
      action: 'reviewed',
      message: `Review complete: ${action}`,
      findingsCount: result.findings.length,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export { createGitHubClient, type GitHubConfig };
