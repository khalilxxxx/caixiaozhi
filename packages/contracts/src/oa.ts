import { z } from 'zod';
import { ResourceRefSchema, VersionSchema } from './common.js';
import {
  BusinessDateSchema,
  NonNegativeMoneySchema,
} from './finance-common.js';

export const OaStateSchema = z.enum([
  'draft',
  'pending_manager',
  'approved',
  'returned',
  'withdrawn',
]);
export const OaDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  entertainment_date: BusinessDateSchema.nullable(),
  entertained_party: z.string().max(200),
  purpose: z.string().max(2000),
  budget: NonNegativeMoneySchema.nullable(),
});
export const OaCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).default('未命名招待申请'),
});
export const OaSaveSchema = OaDraftSchema.extend({
  expected_version: VersionSchema,
});
export const OaMessageDraftSchema = z.strictObject({
  message_kind: z.enum(['supplement', 'result', 'reminder']),
  subject: z.string().min(1).max(100),
  body: z.string().min(1).max(2000),
  recipient_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
  resource_ref: ResourceRefSchema,
});
export const OaMessageSaveSchema = OaMessageDraftSchema.extend({
  expected_version: VersionSchema,
});
export type OaDraft = z.infer<typeof OaDraftSchema>;
