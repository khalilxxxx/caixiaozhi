import { z } from 'zod';
import {
  BusinessObjectFieldsSchema,
  MoneySchema,
  ResourceRefSchema,
  VersionSchema,
} from './common.js';

export const RuleCategorySchema = z.enum([
  'invoice',
  'transport',
  'lodging',
  'meals',
  'itinerary',
  'general',
]);
export const ReviewerPurposeSchema = z.enum([
  'employee_precheck',
  'manager_review',
  'finance_review',
]);
export const RuleModuleSchema = z.enum([
  'expense_claim',
  'travel',
  'oa_request',
]);
export const SrsDocumentRefSchema = ResourceRefSchema.extend({
  type: RuleModuleSchema,
});
const VersionRefSchema = z.strictObject({
  id: z.string().min(1),
  version: VersionSchema,
});
export const SrsInputSchema = z.strictObject({
  schema_version: z.literal(1),
  document: SrsDocumentRefSchema,
  business_date: z.iso.date(),
  applicant_id: z.string().min(1),
  department_id: z.string().min(1),
  total_amount: MoneySchema.nullable(),
  expense_items: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        category: RuleCategorySchema,
        source_expense_type: z.string().nullable(),
        amount: MoneySchema.nullable(),
        invoice_refs: z.array(z.string().min(1)),
        spent_on: z.iso.date().nullable(),
        room_nights: z
          .string()
          .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
          .nullable(),
        oa_request_ref: ResourceRefSchema.nullable(),
      }),
    )
    .max(500),
  invoices: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        amount: MoneySchema.nullable(),
        invoice_number: z.string().nullable(),
        verified: z.boolean().nullable(),
      }),
    )
    .max(500),
  travel: z
    .strictObject({
      start_on: z.iso.date().nullable(),
      end_on: z.iso.date().nullable(),
      request_ref: ResourceRefSchema.nullable(),
    })
    .optional(),
  external_facts: z.record(
    z.string(),
    z.strictObject({
      value: z.unknown(),
      provenance: z.string(),
      state: z.enum(['known', 'unknown']),
    }),
  ),
  field_states: z.record(
    z.string(),
    z.strictObject({
      state: z.enum(['known', 'missing', 'unmapped', 'unavailable']),
      reason: z.string().nullable(),
    }),
  ),
});
export const SrsProjectionProvenanceSchema = z.strictObject({
  source_ref: SrsDocumentRefSchema,
  materials_version: VersionSchema,
  invoice_versions: z.array(VersionRefSchema),
  external_refs: z.array(ResourceRefSchema),
  field_catalog_version: VersionSchema,
  mapping_versions: z.array(VersionRefSchema),
  normalization_version: z.string().min(1),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const SrsInputSnapshotSchema = z
  .strictObject({
    input: SrsInputSchema,
    provenance: SrsProjectionProvenanceSchema,
  })
  .refine(
    (v) =>
      v.input.document.id === v.provenance.source_ref.id &&
      v.input.document.version === v.provenance.source_ref.version &&
      v.input.document.type === v.provenance.source_ref.type,
    '输入与来源必须来自同一单据版本',
  );
export type SrsInput = z.infer<typeof SrsInputSchema>;
export type SrsProjectionProvenance = z.infer<
  typeof SrsProjectionProvenanceSchema
>;
export type SrsInputSnapshot = z.infer<typeof SrsInputSnapshotSchema>;
export type ReviewerPurpose = z.infer<typeof ReviewerPurposeSchema>;
export type Truth = 'true' | 'false' | 'unknown';
export type Literal =
  string | boolean | { amount_minor: string; currency: 'CNY' } | string[];
export type ValueNode =
  | { op: 'field'; path: string }
  | { op: 'literal'; value: Literal }
  | {
      op: 'sum';
      collection: 'expense_items' | 'invoices';
      where?: Predicate;
      value: ValueNode;
    }
  | { op: 'count'; collection: 'expense_items' | 'invoices'; where?: Predicate }
  | { op: 'multiply'; left: ValueNode; right: ValueNode };
export type Predicate =
  | { op: 'all' | 'any'; args: Predicate[] }
  | { op: 'not'; arg: Predicate }
  | {
      op: 'compare';
      comparator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
      left: ValueNode;
      right: ValueNode;
    }
  | { op: 'exists'; value: ValueNode }
  | {
      op: 'for_each';
      collection: 'expense_items' | 'invoices';
      where?: Predicate;
      predicate: Predicate;
    };
export const ValueNodeSchema: z.ZodType<ValueNode> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('field'), path: z.string().min(1) }),
    z.strictObject({
      op: z.literal('literal'),
      value: z.union([
        z.string(),
        z.boolean(),
        MoneySchema,
        z.array(z.string()),
      ]),
    }),
    z.strictObject({
      op: z.literal('sum'),
      collection: z.enum(['expense_items', 'invoices']),
      where: PredicateSchema.optional(),
      value: ValueNodeSchema,
    }),
    z.strictObject({
      op: z.literal('count'),
      collection: z.enum(['expense_items', 'invoices']),
      where: PredicateSchema.optional(),
    }),
    z.strictObject({
      op: z.literal('multiply'),
      left: ValueNodeSchema,
      right: ValueNodeSchema,
    }),
  ]),
);
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.strictObject({
      op: z.enum(['all', 'any']),
      args: z.array(PredicateSchema).min(1),
    }),
    z.strictObject({ op: z.literal('not'), arg: PredicateSchema }),
    z.strictObject({
      op: z.literal('compare'),
      comparator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']),
      left: ValueNodeSchema,
      right: ValueNodeSchema,
    }),
    z.strictObject({ op: z.literal('exists'), value: ValueNodeSchema }),
    z.strictObject({
      op: z.literal('for_each'),
      collection: z.enum(['expense_items', 'invoices']),
      where: PredicateSchema.optional(),
      predicate: PredicateSchema,
    }),
  ]),
);
export const RuleApplicabilitySchema = z
  .strictObject({
    modules: z.array(RuleModuleSchema).min(1),
    department_ids: z.array(z.string().min(1)).min(1),
    purposes: z.array(ReviewerPurposeSchema).min(1),
    basis: z.enum(['submitted_date', 'evaluation_date', 'expense_date']),
    unit: z.enum([
      'document_category_total',
      'item',
      'document',
      'room_night',
      'invoice',
      'person_day',
    ]),
    condition: PredicateSchema.optional(),
    effective_from: z.iso.date().default('2026-01-01'),
    effective_to: z.iso.date().nullable().default(null),
  })
  .refine((v) => v.effective_to === null || v.effective_to > v.effective_from);
const DslFields = {
  dsl_version: z.literal(1),
  applicability: RuleApplicabilitySchema,
  predicate: PredicateSchema,
};
export const RuleDslSchema = z.discriminatedUnion('outcome_mode', [
  z.strictObject({
    ...DslFields,
    outcome_mode: z.literal('mandatory_check'),
    failure_kind: z.enum(['violation', 'missing_evidence']),
  }),
  z.strictObject({
    ...DslFields,
    outcome_mode: z.literal('attention_trigger'),
  }),
]);
export const RuleDraftInputSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    level: z.enum(['company', 'personal']),
    category: RuleCategorySchema,
    dsl_json: RuleDslSchema,
    source_citation_ids: z.array(z.string()).default([]),
    source_kind: z
      .enum(['policy', 'manual_company_decision', 'personal'])
      .default('personal'),
  })
  .refine((v) =>
    v.level === 'company'
      ? v.dsl_json.outcome_mode === 'mandatory_check' &&
        v.source_kind !== 'personal'
      : v.dsl_json.outcome_mode === 'attention_trigger' &&
        v.source_kind === 'personal',
  );
export const RuleProposalSchema = z.strictObject({
  natural_language: z.string().min(1).max(2000),
  module: RuleModuleSchema,
  purpose: ReviewerPurposeSchema,
  current_rule_ref: ResourceRefSchema.optional(),
  source_refs: z.array(z.string()).optional(),
});
export const RuleViewSchema = BusinessObjectFieldsSchema.extend({
  owner_id: z.string(),
  name: z.string(),
  level: z.enum(['company', 'personal']),
  category: RuleCategorySchema,
  lifecycle: z.enum([
    'clarification_required',
    'draft',
    'ready',
    'active',
    'disabled',
    'archived',
  ]),
  active_version_id: z.string().nullable(),
  draft_version_id: z.string().nullable(),
});
export type RuleDsl = z.infer<typeof RuleDslSchema>;
export type RuleDraftInput = z.infer<typeof RuleDraftInputSchema>;

export const RuleTestSetIdSchema = z.literal('boundary-v1');
export const RuleManualTestSetIdSchema = z
  .string()
  .regex(/^rts-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const RuleTestSetRefSchema = z.union([
  RuleTestSetIdSchema,
  RuleManualTestSetIdSchema,
]);
export const RuleManualTestCaseSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  input: SrsInputSchema,
  expected_truth: z.enum(['true', 'false', 'unknown']),
});
const RuleManualTestCasesSchema = z
  .array(RuleManualTestCaseSchema)
  .min(4)
  .max(100)
  .refine(
    (cases) =>
      new Set(cases.map((sample) => sample.name)).size === cases.length,
    '人工样例名称不能重复',
  );
export const RuleTestSetCreateSchema = z.strictObject({
  expected_version: VersionSchema,
  name: z.string().trim().min(1).max(120),
  cases: RuleManualTestCasesSchema,
});
export const RuleTestSetViewSchema = z
  .strictObject({
    id: RuleManualTestSetIdSchema,
    rule_id: z.string().min(1),
    owner_id: z.string().min(1),
    rule_version: VersionSchema,
    draft_version_id: z.string().min(1),
    draft_version: VersionSchema,
    draft_hash: z.string().min(1),
    name: z.string().min(1).max(120),
    cases: RuleManualTestCasesSchema,
    case_count: z.number().int().min(4).max(100),
    test_set_hash: z.string().regex(/^[a-f0-9]{64}$/),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['current', 'stale']),
    created_at: z.iso.datetime(),
  })
  .refine((set) => set.case_count === set.cases.length, '样例数量不一致');
export const RuleTestSetListSchema = z.strictObject({
  items: z.array(RuleTestSetViewSchema),
  next_cursor: z.null(),
});
export const RuleTestStartSchema = z.strictObject({
  expected_version: VersionSchema,
  test_set_id: RuleTestSetRefSchema,
});
// 已发布finance.rules.test@1.0.0只支持boundary-v1；其schema不得随HTTP扩展而改变。
export const RuleTestToolInputSchema = z.strictObject({
  rule_id: z.string().min(1),
  draft_version: VersionSchema,
  test_set_id: RuleTestSetIdSchema,
});
export const RuleTestTaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'stale',
  'cancelled',
]);
export const RuleTestProofSchema = z.strictObject({
  test_run_id: z.string().min(1),
  passed: z.boolean(),
  compiled_hash: z.string().min(1),
  draft_hash: z.string().min(1),
  mapping_hash: z.string().min(1),
  test_set_hash: z.string().min(1),
  results: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        expected_truth: z.enum(['true', 'false', 'unknown']),
        truth: z.enum(['true', 'false', 'unknown']),
        field_refs: z.array(z.string()),
        unknown_reasons: z.array(z.string()),
        trace: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .length(4),
});
export const RuleTestHttpProofSchema = RuleTestProofSchema.extend({
  results: z.array(RuleTestProofSchema.shape.results.element).min(4).max(100),
});
export const RuleTestTaskAcceptedSchema = z.strictObject({
  task_id: z.string().min(1),
  test_run_id: z.string().min(1),
  rule_id: z.string().min(1),
  job_id: z.string().min(1),
  origin_run_id: z.string().nullable(),
  status: z.literal('queued'),
  poll_after_ms: z.number().int().positive(),
});
export const RuleTestTaskViewSchema = z
  .strictObject({
    id: z.string().min(1),
    task_id: z.string().min(1),
    test_run_id: z.string().min(1),
    rule_id: z.string().min(1),
    job_id: z.string().min(1),
    origin_run_id: z.string().nullable(),
    status: RuleTestTaskStatusSchema,
    version: VersionSchema,
    rule_version: VersionSchema,
    draft_version_id: z.string().min(1),
    draft_version: VersionSchema,
    draft_hash: z.string().min(1),
    compiled_hash: z.string().min(1),
    mapping_hash: z.string().min(1),
    test_set_hash: z.string().min(1),
    test_set_id: RuleTestSetRefSchema,
    total_cases: z.number().int().min(4).max(100),
    completed_cases: z.number().int().min(0).max(100),
    cases: z
      .array(
        z.strictObject({
          case_id: z.string(),
          name: z.string(),
          amount_minor: MoneySchema.shape.amount_minor.nullable(),
          expected_truth: z.enum(['true', 'false', 'unknown']),
        }),
      )
      .min(4)
      .max(100),
    proof: RuleTestHttpProofSchema.nullable(),
    error_code: z.string().nullable(),
    created_at: z.iso.datetime(),
    finished_at: z.iso.datetime().nullable(),
  })
  .refine(
    (task) =>
      task.cases.length === task.total_cases &&
      task.completed_cases <= task.total_cases &&
      (task.test_set_id !== 'boundary-v1' || task.total_cases === 4) &&
      (task.proof === null || task.proof.results.length === task.total_cases),
    '测试任务样例数量不一致',
  );
export type RuleTestStart = z.infer<typeof RuleTestStartSchema>;
export type RuleTestProof = z.infer<typeof RuleTestProofSchema>;
export type RuleTestSetCreate = z.infer<typeof RuleTestSetCreateSchema>;
export type RuleTestSetView = z.infer<typeof RuleTestSetViewSchema>;
export type RuleTestSetList = z.infer<typeof RuleTestSetListSchema>;
export type RuleTestTaskAccepted = z.infer<typeof RuleTestTaskAcceptedSchema>;
export type RuleTestTaskView = z.infer<typeof RuleTestTaskViewSchema>;
