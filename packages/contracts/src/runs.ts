import { z } from 'zod';
import {
  IdentifierSchema,
  ResourceRefSchema,
  RunStatusSchema,
  VersionSchema,
} from './common.js';

export const RunBudgetsSchema = z.strictObject({
  model_calls: z.number().int().positive().default(12),
  tool_calls: z.number().int().positive().default(30),
  output_tokens: z.number().int().positive().default(16000),
  active_ms: z.number().int().positive().default(600000),
});
export const CreateRunSchema = z.strictObject({
  thread_id: IdentifierSchema,
  input_message_id: IdentifierSchema,
  selected_skill_version_id: IdentifierSchema.optional(),
});
export const ResumeRunSchema = z.strictObject({
  expected_version: VersionSchema,
  checkpoint_id: IdentifierSchema,
  input: z.unknown().optional(),
});
export const CancelRunSchema = z.strictObject({
  expected_version: VersionSchema,
  reason: z.string().min(1).max(500).default('用户请求停止'),
});
export const CheckpointSchema = z.strictObject({
  stage: z.enum([
    'waiting_user',
    'waiting_confirmation',
    'waiting_domain_job',
    'safe_point',
    'reconciling',
    'interrupted',
  ]),
  pending_input_schema: z
    .record(z.string(), z.unknown())
    .nullable()
    .default(null),
  pending_confirmation_id: IdentifierSchema.nullable().default(null),
  waiting_job_ref: z
    .strictObject({
      id: IdentifierSchema,
      kind: IdentifierSchema,
      generation: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  completed_call_ids: z.array(IdentifierSchema).default([]),
  action_ids: z.array(IdentifierSchema).default([]),
  resource_refs: z.array(ResourceRefSchema).default([]),
  context_refs: z.array(IdentifierSchema).default([]),
  runtime_session_id: IdentifierSchema.nullable().default(null),
  persisted_log_offset: z.number().int().nonnegative().nullable().default(null),
  recovery_mode: z
    .enum(['application_checkpoint', 'readonly_replay', 'receipt_only'])
    .default('application_checkpoint'),
});
export const RunUsageSchema = z.strictObject({
  model_calls: z.number().int().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
  cost_amount: z.string().nullable(),
});
export const RunSchema = z.strictObject({
  id: IdentifierSchema,
  tenant_id: IdentifierSchema,
  owner_id: IdentifierSchema,
  version: VersionSchema,
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  origin: z.enum(['conversation', 'subscription']),
  thread_id: IdentifierSchema.nullable(),
  input_message_id: IdentifierSchema.nullable(),
  occurrence_id: IdentifierSchema.nullable(),
  status: RunStatusSchema,
  phase: z.string().nullable(),
  runtime_active: z.boolean(),
  checkpoint_id: IdentifierSchema.nullable(),
  selected_skill_version_id: IdentifierSchema.nullable(),
  cancel_requested_at: z.iso.datetime().nullable(),
  started_at: z.iso.datetime().nullable(),
  finished_at: z.iso.datetime().nullable(),
  attempt: z.number().int().nonnegative(),
  trace_id: IdentifierSchema,
  error_code: z.string().nullable(),
  last_seq: z.number().int().nonnegative(),
  parent_run_id: IdentifierSchema.nullable(),
  budgets: RunBudgetsSchema,
  usage: RunUsageSchema,
});
export const EVENT_CURSOR_EXPIRED = 'EVENT_CURSOR_EXPIRED' as const;
export type Run = z.infer<typeof RunSchema>;
export type RunBudgets = z.infer<typeof RunBudgetsSchema>;
export type RunUsage = z.infer<typeof RunUsageSchema>;
export type RunCheckpoint = z.infer<typeof CheckpointSchema>;
export type CreateRunInput = z.infer<typeof CreateRunSchema>;
