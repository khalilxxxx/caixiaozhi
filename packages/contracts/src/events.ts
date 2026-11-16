import { z } from 'zod';
import { IdentifierSchema, UtcDateTimeSchema } from './common.js';

export const SseEventTypeSchema = z.enum([
  'run.status',
  'assistant.delta',
  'assistant.message',
  'tool.started',
  'tool.completed',
  'card.upsert',
  'confirmation.required',
  'usage.updated',
  'run.error',
]);

// 本期只冻结事件信封，各领域 payload 在对应模块实现时收紧。
export const SseEventSchema = z.strictObject({
  run_id: IdentifierSchema,
  seq: z.number().int().positive(),
  type: SseEventTypeSchema,
  occurred_at: UtcDateTimeSchema,
  payload: z.unknown(),
});

export const RunEventSchema = SseEventSchema;
export type SseEventType = z.infer<typeof SseEventTypeSchema>;
export type SseEvent = z.infer<typeof SseEventSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
