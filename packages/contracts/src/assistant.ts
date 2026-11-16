import { z } from 'zod';
import {
  IdentifierSchema,
  ResourceRefSchema,
  VersionSchema,
} from './common.js';

export const AcceptMessageSchema = z.strictObject({
  content: z.string().trim().min(1).max(8000),
  client_message_id: IdentifierSchema,
  intent: z.enum(['continue', 'new_task']).default('continue'),
  expected_version: VersionSchema,
  resource_refs: z.array(ResourceRefSchema).max(20).default([]),
  attachment_ids: z.array(IdentifierSchema).max(20).default([]),
  selected_skill_version_id: IdentifierSchema.optional(),
});
export const CreateThreadSchema = z.strictObject({
  title: z.string().trim().min(1).max(80).nullable().default(null),
  initial_message: AcceptMessageSchema.omit({ expected_version: true })
    .nullable()
    .default(null),
});
export const RenameThreadSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  expected_version: VersionSchema,
});
export const ThreadSchema = z.strictObject({
  id: IdentifierSchema,
  tenant_id: IdentifierSchema,
  owner_id: IdentifierSchema,
  version: VersionSchema,
  title: z.string(),
  active_run_id: IdentifierSchema.nullable(),
  last_message_seq: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export const MessageSchema = z.strictObject({
  id: IdentifierSchema,
  thread_id: IdentifierSchema,
  seq: z.number().int().positive(),
  role: z.enum(['user', 'assistant', 'system_notice']),
  content: z.string(),
  status: z.enum(['accepted', 'pending_consumption', 'final', 'failed']),
  run_id: IdentifierSchema.nullable(),
  resource_refs: z.array(ResourceRefSchema),
  created_at: z.iso.datetime(),
});
export type AcceptMessage = z.infer<typeof AcceptMessageSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Message = z.infer<typeof MessageSchema>;
