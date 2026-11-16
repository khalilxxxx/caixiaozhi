import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import type {
  DatabaseConnection,
  DatabaseExecutor,
  Transaction,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from './hash.js';
import type { DurableJob } from '@caixiaozhi/jobs/queue';
export const nowIso = () => new Date().toISOString();
export const iso = (value: unknown) => new Date(value as string).toISOString();
export const date = (value: unknown) =>
  typeof value === 'string' ? value.slice(0, 10) : iso(value).slice(0, 10);
export const json = (value: unknown) => JSON.stringify(value);
export async function rows<T = Record<string, unknown>>(
  db: DatabaseExecutor,
  query: Parameters<DatabaseExecutor['execute']>[0],
): Promise<T[]> {
  return (await db.execute(query)).rows as T[];
}
export async function command<T>(
  database: DatabaseConnection,
  ctx: ActorContext,
  operation: string,
  key: string,
  payload: unknown,
  execute: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw new AppError('VALIDATION_ERROR', '写入操作需要有效请求编号。');
  const hash = canonicalHash(payload);
  return database.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenant_id}:${ctx.user_id}:${operation}:${key}`}))`,
    );
    const prior = await rows<{ payload_hash: string; result: T }>(
      tx,
      sql`SELECT payload_hash,result FROM finance_commands WHERE tenant_id=${ctx.tenant_id} AND actor_id=${ctx.user_id} AND operation=${operation} AND idempotency_key=${key}`,
    );
    if (prior[0]) {
      if (prior[0].payload_hash !== hash)
        throw new AppError('IDEMPOTENCY_CONFLICT', '请求编号已用于不同内容。');
      return prior[0].result;
    }
    const result = await execute(tx);
    await tx.execute(
      sql`INSERT INTO finance_commands(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES(${ctx.tenant_id},${ctx.user_id},${operation},${key},${hash},${json(result)}::jsonb)`,
    );
    return result;
  });
}
export async function revision(
  tx: DatabaseExecutor,
  tenantId: string,
  id: string,
  lock = false,
): Promise<number> {
  await tx.execute(
    sql`INSERT INTO finance_revision_guards(tenant_id,id) VALUES(${tenantId},${id}) ON CONFLICT DO NOTHING`,
  );
  const result = await rows<{ revision: number }>(
    tx,
    lock
      ? sql`SELECT revision FROM finance_revision_guards WHERE tenant_id=${tenantId} AND id=${id} FOR SHARE`
      : sql`SELECT revision FROM finance_revision_guards WHERE tenant_id=${tenantId} AND id=${id}`,
  );
  return result[0]!.revision;
}
export async function bump(
  tx: DatabaseExecutor,
  tenantId: string,
  id: string,
): Promise<number> {
  await revision(tx, tenantId, id);
  const result = await rows<{ revision: number }>(
    tx,
    sql`UPDATE finance_revision_guards SET revision=revision+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${id} RETURNING revision`,
  );
  return result[0]!.revision;
}
export async function outbox(
  tx: DatabaseExecutor,
  ctx: ActorContext,
  eventType: string,
  resourceType: string,
  resourceId: string,
  version: number,
  payload: Record<string, unknown>,
) {
  await tx.execute(
    sql`INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload) VALUES(${randomUUID()},${ctx.tenant_id},${eventType},1,${resourceType},${resourceId},${version},now(),${json(payload)}::jsonb)`,
  );
}
export async function assertDomainLease(
  tx: DatabaseExecutor,
  job: DurableJob,
): Promise<void> {
  const valid = await rows(
    tx,
    sql`SELECT j.id FROM durable_jobs j JOIN identity_environments e ON e.tenant_id=j.tenant_id WHERE j.id=${job.id} AND j.tenant_id=${job.tenant_id} AND j.status='running' AND j.lease_owner=${job.lease_owner} AND j.lease_epoch=${job.lease_epoch} AND j.generation=${job.generation} AND j.generation=e.generation AND j.lease_until>clock_timestamp() FOR SHARE OF j`,
  );
  if (!valid[0])
    throw new AppError('INVALID_STATE', '领域任务租约或演示代次已失效。', {
      details: { reason: 'LEASE_LOST' },
    });
}
