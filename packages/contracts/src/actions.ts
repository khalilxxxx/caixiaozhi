import { z } from 'zod';
import {
  ActionReceiptSchema,
  ResourceRefSchema,
  VersionSchema,
} from './common.js';

// 唯一 operation registry；领域页面和工具必须复用这些名称。
export const ActionNameSchema = z.enum([
  'travel.submit',
  'travel.resubmit',
  'travel.withdraw',
  'expense.submit',
  'expense.resubmit',
  'expense.withdraw',
  'oa.submit',
  'oa.resubmit',
  'oa.withdraw',
  'approval.approve',
  'approval.return',
  'approval.batch_approve',
  'rule.enable',
  'rule.publish',
  'rule.disable',
  'rule.mapping.publish',
  'skill.publish',
  'oa.message.send',
  'policy.publish',
  'policy.withdraw',
  'integration.capability.publish',
  'integration.capability.disable',
]);
export const ACTION_NAMES = ActionNameSchema.options;
export type ActionName = z.infer<typeof ActionNameSchema>;
export const ActionStateSchema = z.enum([
  'prepared',
  'confirmed',
  'executing',
  'succeeded',
  'rejected',
  'failed',
  'unknown',
  'cancelled',
  'expired',
]);
export type ActionState = z.infer<typeof ActionStateSchema>;
export const TaskRefSchema = z.strictObject({
  id: z.string().min(1),
  version: VersionSchema,
});
export type TaskRef = z.infer<typeof TaskRefSchema>;
export const DependencyRefSchema = z.strictObject({
  type: z.string().min(1),
  id: z.string().min(1),
  version: z.union([VersionSchema, z.string().min(1)]),
});
export type DependencyRef = z.infer<typeof DependencyRefSchema>;
export const PrepareInputSchema = z.strictObject({
  action: ActionNameSchema,
  resource_refs: z.array(ResourceRefSchema).max(50),
  args: z.unknown(),
  idempotency_key: z.string().min(1).max(200),
  run_id: z.string().min(1).nullable().optional(),
  trace_id: z.string().min(1).nullable().optional(),
  dependency_refs: z.array(DependencyRefSchema).optional(),
  extra_guards: z.record(z.string(), z.unknown()).optional(),
});
export type PrepareInput = z.infer<typeof PrepareInputSchema>;
export const ConfirmInputSchema = z.strictObject({
  expected_version: VersionSchema,
  summary_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation_token: z.string().min(1).max(4096),
});
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>;
export const ActionItemViewSchema = z.strictObject({
  id: z.string(),
  ordinal: z.number().int().nonnegative(),
  resource_ref: ResourceRefSchema.nullable(),
  task_ref: TaskRefSchema.nullable(),
  state: ActionStateSchema,
  receipt: ActionReceiptSchema.nullable(),
});
export const ActionViewSchema = z.strictObject({
  id: z.string(),
  confirmation_id: z.string(),
  operation: ActionNameSchema,
  state: ActionStateSchema,
  version: VersionSchema,
  resource_refs: z.array(ResourceRefSchema),
  items: z.array(ActionItemViewSchema),
  summary: z.strictObject({
    succeeded: z.number().int(),
    rejected: z.number().int(),
    failed: z.number().int(),
    unknown: z.number().int(),
    cancelled: z.number().int(),
  }),
  next_poll_after_ms: z.number().int().positive().nullable(),
});
export type ActionView = z.infer<typeof ActionViewSchema>;
export type ActionItemView = z.infer<typeof ActionItemViewSchema>;
export type ConfirmationView = {
  action_id: string;
  confirmation_id: string;
  version: number;
  summary: unknown;
  summary_hash: string;
  expires_at: string;
  state: ActionState;
};
export type InteractiveConfirmationReview = ConfirmationView & {
  confirmation_token: string | null;
  token_expires_at: string | null;
};
