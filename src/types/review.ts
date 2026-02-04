import { z } from 'zod';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const CategorySchema = z.enum([
  'security',
  'performance',
  'logic',
  'error-handling',
  'type-safety',
  'maintainability',
]);
export type Category = z.infer<typeof CategorySchema>;

export const FindingSchema = z.object({
  severity: SeveritySchema,
  category: CategorySchema,
  confidence: ConfidenceSchema,
  file: z.string(),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  title: z.string(),
  description: z.string(),
  suggestion: z.string().optional(),
  severityReason: z.string(),
  references: z.array(z.string()).optional(),
  hash: z.string(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ReviewMetadataSchema = z.object({
  headCommit: z.string(),
  filesReviewed: z.number().int().nonnegative(),
  skippedFiles: z.array(z.string()),
  reviewDurationMs: z.number().int().nonnegative(),
});
export type ReviewMetadata = z.infer<typeof ReviewMetadataSchema>;

export const ReviewStatusSchema = z.enum(['completed', 'skipped', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewResultSchema = z.object({
  status: ReviewStatusSchema,
  summary: z.string(),
  findings: z.array(FindingSchema),
  metadata: ReviewMetadataSchema,
  error: z.string().optional(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type ReviewAction = 'request_changes' | 'comment' | 'approve';

export function determineReviewAction(findings: Finding[]): ReviewAction {
  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasHigh = findings.some((f) => f.severity === 'high');

  if (hasCritical) {
    return 'request_changes';
  }
  if (hasHigh) {
    return 'comment';
  }
  return 'approve';
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
  };
}

export const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
