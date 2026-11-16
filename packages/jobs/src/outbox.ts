import { randomUUID } from 'node:crypto';
import type { Transaction } from '@caixiaozhi/platform/database';
import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { z } from 'zod';

export const outboxEvents = pgTable('outbox_events', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  eventType: text('event_type').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  resourceVersion: integer('resource_version').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

const eventSchema = z
  .object({
    id: z.string().min(1).optional(),
    tenantId: z.string().min(1),
    eventType: z.string().min(1),
    schemaVersion: z.number().int().positive().default(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
    resourceVersion: z.number().int().positive(),
    occurredAt: z.date().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type OutboxInput = z.input<typeof eventSchema>;
export type OutboxEvent = typeof outboxEvents.$inferSelect;

/** 与领域写入共用事务，强制拒绝顶层未知字段。嵌套对象由领域 schema 显式约束。 */
export async function enqueueOutbox(
  transaction: Transaction,
  input: OutboxInput,
  payloadSchema: z.ZodObject,
): Promise<OutboxEvent> {
  const envelope = eventSchema.parse(input);
  const payload = payloadSchema.strict().parse(envelope.payload);
  const [event] = await transaction
    .insert(outboxEvents)
    .values({
      ...envelope,
      id: envelope.id ?? randomUUID(),
      occurredAt: envelope.occurredAt ?? new Date(),
      payload,
    })
    .returning();
  if (!event) throw new Error('Outbox 写入未返回记录。');
  return event;
}
