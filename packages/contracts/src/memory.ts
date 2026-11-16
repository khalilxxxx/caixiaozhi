import { z } from 'zod';
import { IdentifierSchema, ResourceRefSchema } from './common.js';

export const MemoryInputSchema = z.strictObject({
  kind: z.enum(['response_preference', 'input_preference', 'personal_context']),
  key: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(2000),
  value: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
  expires_at: z.iso.datetime().nullable().default(null),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('manual') }),
    z.strictObject({
      kind: z.literal('explicit_message'),
      message_id: IdentifierSchema,
    }),
  ]),
  explicit_save: z.literal(true),
});
export const DigestScheduleSchema = z.strictObject({
  frequency: z.enum(['daily', 'weekdays']),
  local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, '时区无效'),
  start_date: z.iso.date(),
});
export const DigestQuerySchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('current_approval_scope'),
    include_existing_preaudit: z.boolean().default(true),
  }),
  z.strictObject({
    scope: z.enum(['own_expenses', 'authorized_department_expenses']),
    period: z.enum(['this_month', 'last_month']),
  }),
  z.strictObject({
    scope: z.literal('documents'),
    resource_refs: z.array(ResourceRefSchema).min(1).max(50),
  }),
]);
export const SubscriptionInputSchema = z
  .strictObject({
    type: z.enum(['todo_digest', 'expense_digest', 'document_progress']),
    title: z.string().trim().min(1).max(60),
    schedule: DigestScheduleSchema,
    query_spec: DigestQuerySchema,
    skill_version_id: IdentifierSchema.nullable().default(null),
    delivery: z.strictObject({ channel: z.literal('in_app') }),
  })
  .refine(
    (input) =>
      input.type === 'todo_digest'
        ? input.query_spec.scope === 'current_approval_scope'
        : input.type === 'document_progress'
          ? input.query_spec.scope === 'documents'
          : ['own_expenses', 'authorized_department_expenses'].includes(
              input.query_spec.scope,
            ),
    '摘要类型与读取范围不匹配',
  );
export const DigestResultSchema = z.strictObject({
  title: z.string().min(1).max(80),
  preview: z.string().max(280),
  content: z.string().max(16000),
  source_refs: z.array(ResourceRefSchema),
  coverage: z.enum(['complete', 'partial', 'unavailable']),
  generated_at: z.iso.datetime(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;
export type DigestSchedule = z.infer<typeof DigestScheduleSchema>;
export type SubscriptionInput = z.infer<typeof SubscriptionInputSchema>;
export type DigestQuery = z.infer<typeof DigestQuerySchema>;
export type DigestResult = z.infer<typeof DigestResultSchema>;
