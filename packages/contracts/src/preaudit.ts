import { z } from 'zod';
import { MoneySchema, ResourceRefSchema, VersionSchema } from './common.js';
import { ReviewerPurposeSchema, SrsDocumentRefSchema } from './rules.js';
export const PreauditGroupSchema = z.enum([
  'risk',
  'incomplete',
  'attention',
  'low',
]);
export const PreauditTaskStateSchema = z.enum([
  'queued',
  'running',
  'completed',
  'partial_failed',
  'failed',
  'cancelled',
]);
export const PreauditItemStateSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'stale',
]);
export const StartPreauditSchema = z
  .strictObject({
    purpose: ReviewerPurposeSchema,
    documents: z.array(SrsDocumentRefSchema).min(1).max(100),
  })
  .refine(
    (v) =>
      new Set(v.documents.map((d) => `${d.type}:${d.id}`)).size ===
      v.documents.length,
    '预审选择不能重复',
  );
export const PreauditCoverageSchema = z.strictObject({
  company_required_total: z.number().int().nonnegative(),
  company_known_total: z.number().int().nonnegative(),
  company_unknown_total: z.number().int().nonnegative(),
  company_not_applicable_total: z.number().int().nonnegative(),
  company_missing_evidence_total: z.number().int().nonnegative(),
  personal_selected_total: z.number().int().nonnegative(),
  personal_known_total: z.number().int().nonnegative(),
  personal_unknown_total: z.number().int().nonnegative(),
  missing_fields: z.array(z.string()),
  failed_dependencies: z.array(z.string()),
});
const VersionRef = z.strictObject({ id: z.string(), version: VersionSchema });
export const PreauditVersionLockSchema = z.strictObject({
  document_ref: ResourceRefSchema,
  materials_version: VersionSchema,
  invoice_versions: z.array(VersionRef),
  external_refs: z.array(ResourceRefSchema),
  company_ruleset_revision: VersionSchema,
  company_rule_refs: z.array(ResourceRefSchema),
  personal_ruleset_revision: VersionSchema,
  personal_rule_refs: z.array(ResourceRefSchema),
  field_catalog_version: VersionSchema,
  mapping_versions: z.array(VersionRef),
  policy_refs: z.array(ResourceRefSchema),
  reviewer_id: z.string(),
  reviewer_purpose: ReviewerPurposeSchema,
  reviewer_scope_hash: z.string(),
  authz_version: VersionSchema,
  approval_task_id: z.string().nullable(),
  approval_task_version: VersionSchema.nullable(),
  effective_basis: z.string(),
  basis_date: z.iso.date(),
});
export const PreauditFindingSchema = z.strictObject({
  id: z.string(),
  rule_ref: ResourceRefSchema.nullable(),
  kind: z.enum([
    'company_violation',
    'company_missing_evidence',
    'unresolved_required',
    'personal_attention',
    'unresolved_personal',
  ]),
  truth: z.enum(['true', 'false', 'unknown']),
  field_refs: z.array(z.string()),
  actual: z.unknown(),
  expected: z.unknown(),
  citation_refs: z.array(z.string()),
  message: z.string(),
});
export const PreauditResultSchema = z.strictObject({
  result_id: z.string(),
  document_ref: ResourceRefSchema,
  status: z.enum(['completed', 'stale']),
  group: PreauditGroupSchema,
  amount: MoneySchema.nullable(),
  coverage: PreauditCoverageSchema,
  eligible_for_bulk_approval: z.boolean(),
  eligibility_reasons: z.array(z.string()),
  findings: z.array(PreauditFindingSchema),
  snapshot_at: z.string(),
  locked_versions: PreauditVersionLockSchema,
  lock_hash: z.string(),
  result_hash: z.string(),
  task_ref: VersionRef.nullable(),
  purpose: ReviewerPurposeSchema,
  reviewer_id: z.string(),
});
export const PreauditTaskAcceptedSchema = z.strictObject({
  task_id: z.string(),
  status: PreauditTaskStateSchema,
  total: z.number().int(),
  origin_run_id: z.string().nullable(),
  poll_after_ms: z.number().int().positive(),
});
export type StartPreauditCommand = z.infer<typeof StartPreauditSchema>;
export type PreauditCoverage = z.infer<typeof PreauditCoverageSchema>;
export type PreauditVersionLock = z.infer<typeof PreauditVersionLockSchema>;
export type PreauditFinding = z.infer<typeof PreauditFindingSchema>;
export type PreauditResult = z.infer<typeof PreauditResultSchema>;
export type PreauditTaskAccepted = z.infer<typeof PreauditTaskAcceptedSchema>;
export type PreauditTaskView = {
  task: {
    id: string;
    tenant_id: string;
    owner_id: string;
    version: number;
    purpose: z.infer<typeof ReviewerPurposeSchema>;
    status: z.infer<typeof PreauditTaskStateSchema>;
    origin_run_id: string | null;
    total: number;
    created_at: string;
    updated_at: string;
  };
  counts: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    stale: number;
  };
  items: Array<{
    id: string;
    document_ref: z.infer<typeof ResourceRefSchema>;
    status: z.infer<typeof PreauditItemStateSchema>;
    result_id: string | null;
    result: PreauditResult | null;
    last_error: { code: string; message: string; retryable: boolean } | null;
    skipped_reason: string | null;
  }>;
  next_cursor: string | null;
  summary: {
    total_amount: z.infer<typeof MoneySchema>;
    groups: Record<
      z.infer<typeof PreauditGroupSchema>,
      { count: number; amount: z.infer<typeof MoneySchema> }
    >;
  };
};
