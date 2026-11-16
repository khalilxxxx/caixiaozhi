import { z } from 'zod';
import {
  IdentifierSchema,
  ResourceRefSchema,
  UtcDateTimeSchema,
  VersionSchema,
  MoneySchema,
} from './common.js';

export const AgentCardTypeSchema = z.enum([
  'todo_summary',
  'preaudit_summary',
  'document_summary',
  'draft_proposal',
  'rule_proposal',
  'policy_answer',
  'analysis_result',
  'report_result',
  'skill_result',
  'action_result',
  'reminder_summary',
]);

export const AgentCardActionSchema = z.strictObject({
  id: IdentifierSchema,
  label: z.string().min(1),
  kind: z.enum([
    'open_drawer',
    'continue_chat',
    'prepare_action',
    'open_source',
  ]),
  target: IdentifierSchema,
});

// 信封只定义公共结构，业务消费必须使用注册 payload 后的 schema。
export const AgentCardEnvelopeSchema = z.strictObject({
  id: IdentifierSchema,
  schema_version: z.literal(1),
  type: AgentCardTypeSchema,
  thread_id: IdentifierSchema,
  message_id: IdentifierSchema,
  run_id: IdentifierSchema.nullable(),
  title: z.string().min(1),
  summary: z.string(),
  snapshot_at: UtcDateTimeSchema,
  resource_refs: z.array(ResourceRefSchema),
  payload: z.record(z.string(), z.unknown()),
  actions: z.array(AgentCardActionSchema),
  revision: VersionSchema,
  stale: z.boolean(),
});

export type AgentCardType = z.infer<typeof AgentCardTypeSchema>;
export type AgentCardAction = z.infer<typeof AgentCardActionSchema>;
export type AgentCard = z.infer<typeof AgentCardEnvelopeSchema>;
export type AgentCardPayloadRegistry = Partial<
  Record<AgentCardType, z.ZodObject>
>;

export type RegisteredAgentCard<Registry extends AgentCardPayloadRegistry> = {
  [Type in keyof Registry & AgentCardType]: Omit<
    AgentCard,
    'type' | 'payload'
  > & {
    type: Type;
    payload: z.output<NonNullable<Registry[Type]>>;
  };
}[keyof Registry & AgentCardType];

export function createAgentCardSchema<
  const Registry extends AgentCardPayloadRegistry,
>(registry: Registry): z.ZodType<RegisteredAgentCard<Registry>> {
  const variants = Object.entries(registry as AgentCardPayloadRegistry).map(
    ([type, payloadSchema]) =>
      AgentCardEnvelopeSchema.extend({
        type: z.literal(AgentCardTypeSchema.parse(type)),
        payload: payloadSchema.strict(),
      }),
  );

  return (variants.length === 0 ? z.never() : z.union(variants)) as z.ZodType<
    RegisteredAgentCard<Registry>
  >;
}

const count = z.number().int().nonnegative();
const counts = z.strictObject({
  risk: count,
  incomplete: count,
  attention: count,
  low: count,
});
export const CardPayloads = {
  todo_summary: z.strictObject({
    count,
    total: MoneySchema,
    list_scope: z.string(),
    source_as_of: UtcDateTimeSchema,
  }),
  preaudit_summary: z.strictObject({
    preaudit_task_id: IdentifierSchema,
    counts,
    totals: z.strictObject({ all: MoneySchema, low: MoneySchema }),
    progress: z.strictObject({ completed: count, total: count }),
    reviewer_id: IdentifierSchema,
  }),
  document_summary: z.strictObject({
    document_ref: ResourceRefSchema,
    status: z.string(),
    total: MoneySchema.nullable(),
    missing_fields: z.array(z.string()),
  }),
  draft_proposal: z.strictObject({
    proposal_id: IdentifierSchema,
    base_ref: ResourceRefSchema.nullable(),
    changes: z.array(
      z.strictObject({
        field: z.string(),
        before: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        after: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        source_ref: IdentifierSchema.nullable().optional(),
      }),
    ),
    validation_summary: z.string(),
  }),
  rule_proposal: z.strictObject({
    proposal_id: IdentifierSchema,
    rule_ref: ResourceRefSchema.nullable(),
    test_summary: z.string().nullable(),
  }),
  policy_answer: z.strictObject({
    answer: z.string(),
    citation_refs: z.array(IdentifierSchema),
    effective_at: UtcDateTimeSchema,
    unresolved_questions: z.array(z.string()),
  }),
  analysis_result: z.strictObject({
    analysis_ref: ResourceRefSchema,
    metric_id: IdentifierSchema,
    filter_summary: z.string(),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
  }),
  report_result: z.strictObject({
    report_ref: ResourceRefSchema,
    generation_status: z.enum(['queued', 'running', 'completed', 'failed']),
    download_action: IdentifierSchema.nullable(),
  }),
  skill_result: z.strictObject({
    invocation_id: IdentifierSchema,
    skill_ref: ResourceRefSchema,
    result_kind: z.enum(['completed', 'partial', 'failed', 'waiting']),
    evidence_refs: z.array(IdentifierSchema),
  }),
  action_result: z.strictObject({
    action_ids: z.array(IdentifierSchema),
    receipt_ids: z.array(IdentifierSchema),
    outcomes: z.array(
      z.strictObject({
        action_id: IdentifierSchema,
        outcome: z.enum(['succeeded', 'rejected', 'failed', 'unknown']),
        error_code: z.string().nullable(),
      }),
    ),
    affected_refs: z.array(ResourceRefSchema),
  }),
  reminder_summary: z.strictObject({
    inbox_item_id: IdentifierSchema,
    generated_at: UtcDateTimeSchema,
    subject_refs: z.array(ResourceRefSchema),
    read_only: z.literal(true),
    origin_run_id: IdentifierSchema.nullable().optional(),
    occurrence_id: IdentifierSchema.optional(),
  }),
} satisfies AgentCardPayloadRegistry;
export const AgentCardSchema = createAgentCardSchema(CardPayloads);
