import {
  Finding,
  ReviewResult,
  Severity,
  SEVERITY_EMOJI,
  countBySeverity,
  determineReviewAction,
} from '../types/review.js';

export function buildFindingComment(finding: Finding, headCommit: string): string {
  const emoji = SEVERITY_EMOJI[finding.severity];
  const severityLabel = finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);

  const lines: string[] = [];

  lines.push(`${emoji} **${severityLabel}** · ${formatCategory(finding.category)}`);
  lines.push('');
  lines.push(finding.description);

  if (finding.suggestion) {
    lines.push('');
    lines.push('```suggestion');
    lines.push(finding.suggestion);
    lines.push('```');
  }

  lines.push('');
  lines.push(`**Confidence:** ${formatConfidence(finding.confidence)}`);
  lines.push(
    `**Why this severity:** ${finding.severityReason}`
  );

  if (finding.references && finding.references.length > 0) {
    lines.push('');
    lines.push('**References:**');
    for (const ref of finding.references) {
      const displayUrl = ref.length > 60 ? ref.substring(0, 57) + '...' : ref;
      lines.push(`- [${displayUrl}](${ref})`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push(`<!-- ai-review: {"hash":"${finding.hash}"} -->`);
  lines.push(`*Claude PR Reviewer • ${headCommit.substring(0, 7)}*`);

  return lines.join('\n');
}

export function buildReviewSummary(result: ReviewResult, headCommit: string): string {
  const action = determineReviewAction(result.findings);
  const counts = countBySeverity(result.findings);

  const lines: string[] = [];

  if (action === 'request_changes') {
    lines.push('🔴 **Changes Requested by Claude PR Reviewer**');
  } else if (action === 'comment') {
    lines.push('🟠 **Review Comments from Claude PR Reviewer**');
  } else {
    lines.push('✅ **Approved by Claude PR Reviewer**');
  }

  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');

  if (counts.critical > 0) {
    lines.push(`| 🔴 Critical | ${counts.critical} |`);
  }
  if (counts.high > 0) {
    lines.push(`| 🟠 High | ${counts.high} |`);
  }
  if (counts.medium > 0) {
    lines.push(`| 🟡 Medium | ${counts.medium} |`);
  }
  if (counts.low > 0) {
    lines.push(`| 🔵 Low | ${counts.low} |`);
  }

  if (result.findings.length === 0) {
    lines.push('| ✅ None | 0 |');
  }

  lines.push('');

  if (action === 'request_changes') {
    lines.push('Please address the critical issues before merging.');
  } else if (action === 'comment') {
    lines.push(
      'High severity issues found. Please review and consider addressing them before merging.'
    );
  } else {
    if (counts.medium > 0 || counts.low > 0) {
      lines.push(
        'No critical or high severity issues found. Please review the medium/low suggestions at your discretion.'
      );
    } else {
      lines.push('No issues found. The code looks good!');
    }
  }

  lines.push('');
  lines.push(`*Reviewed at commit: ${headCommit.substring(0, 7)}*`);

  return lines.join('\n');
}

export function buildSkipComment(reason: string, headCommit: string): string {
  return `⏭️ **Claude PR Reviewer skipped this PR**

${reason}

*Commit: ${headCommit.substring(0, 7)}*`;
}

export function buildStillPresentReply(headCommit: string): string {
  return `⚠️ This issue is still present after the latest changes.

*Claude PR Reviewer • ${headCommit.substring(0, 7)}*`;
}

function formatCategory(category: string): string {
  return category
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatConfidence(confidence: string): string {
  return confidence.charAt(0).toUpperCase() + confidence.slice(1);
}

export function sortFindingsBySeverity(findings: Finding[]): Finding[] {
  const order: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  return [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
}
