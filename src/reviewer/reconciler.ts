import type { Finding } from '../types/review.js';
import type { ExistingComment } from './github-client.js';

export type ReconciliationResult = {
  newFindings: Finding[];
  fixedCommentIds: number[];
  persistingCommentIds: number[];
};

export function reconcileFindings(
  newFindings: Finding[],
  existingComments: ExistingComment[]
): ReconciliationResult {
  const existingHashes = new Set(
    existingComments.filter((c) => c.hash !== null).map((c) => c.hash as string)
  );

  const newHashes = new Set(newFindings.map((f) => f.hash));

  const newFindingsToPost = newFindings.filter((f) => !existingHashes.has(f.hash));

  const fixedCommentIds: number[] = [];
  const persistingCommentIds: number[] = [];

  for (const comment of existingComments) {
    if (comment.hash === null) {
      continue;
    }

    if (newHashes.has(comment.hash)) {
      persistingCommentIds.push(comment.id);
    } else {
      fixedCommentIds.push(comment.id);
    }
  }

  return {
    newFindings: newFindingsToPost,
    fixedCommentIds,
    persistingCommentIds,
  };
}

export function generateHash(file: string, line: number, endLine: number | undefined, title: string): string {
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lineRange = endLine ? `${line}-${endLine}` : `${line}`;
  const input = `${file}:${lineRange}:${normalizedTitle}`;

  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return Math.abs(hash).toString(16).padStart(8, '0');
}

export function hasBlockingIssuesRemaining(
  newFindings: Finding[],
  existingComments: ExistingComment[]
): boolean {
  const reconciliation = reconcileFindings(newFindings, existingComments);

  const blockingFindings = reconciliation.newFindings.filter(
    (f) => f.severity === 'critical'
  );

  return blockingFindings.length > 0;
}

export function shouldDismissPreviousReview(
  newFindings: Finding[]
): boolean {
  const hasCritical = newFindings.some((f) => f.severity === 'critical');
  return !hasCritical;
}
