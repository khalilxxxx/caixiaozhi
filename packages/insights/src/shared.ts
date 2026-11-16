import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database, DatabaseExecutor } from '@caixiaozhi/platform/database';
import type { ActorContext } from '@caixiaozhi/contracts';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalJson, hashPayload } from '@caixiaozhi/action-service';
export const json = (v: unknown) => sql`${canonicalJson(v)}::jsonb`;
export type Row = Record<string, unknown>;
export async function writeCommand<T>(
  db: Database,
  actor: ActorContext,
  operation: string,
  key: string,
  input: unknown,
  execute: (tx: DatabaseExecutor) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw new AppError('VALIDATION_ERROR', '写入需要有效的 Idempotency-Key。');
  const hash = hashPayload(input);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenant_id}:${actor.user_id}:${operation}:${key}`},0))`,
    );
    const prior = (
      await tx.execute(
        sql`SELECT payload_hash,result FROM insights_commands WHERE tenant_id=${actor.tenant_id} AND actor_id=${actor.user_id} AND operation=${operation} AND idempotency_key=${key}`,
      )
    ).rows[0];
    if (prior) {
      if (prior.payload_hash !== hash)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '相同幂等键不能用于不同参数。',
        );
      return prior.result as T;
    }
    const result = await execute(tx);
    await tx.execute(
      sql`INSERT INTO insights_commands(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES(${actor.tenant_id},${actor.user_id},${operation},${key},${hash},${json(result)})`,
    );
    return result;
  });
}
export async function enqueueJob(
  tx: DatabaseExecutor,
  actor: ActorContext,
  kind: string,
  ref: string,
  generation?: number,
) {
  const current =
    generation ??
    Number(
      (
        await tx.execute(
          sql`SELECT generation FROM identity_environments WHERE tenant_id=${actor.tenant_id} FOR SHARE`,
        )
      ).rows[0]?.generation ?? 0,
    );
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation) VALUES(${id},${actor.tenant_id},'insights',${kind},${ref},${ref},${current})`,
  );
  return id;
}
export async function claimInsightJob(
  db: Database,
  id: string,
  workerId: string,
) {
  const row = (
    await db.execute(
      sql`UPDATE durable_jobs SET status='running',lease_owner=${workerId},lease_epoch=lease_epoch+1,lease_until=now()+interval '60 seconds',attempt=attempt+1,version=version+1,updated_at=now() WHERE id=${id} AND owner_module='insights' AND (status='ready' OR (status='running' AND lease_until<clock_timestamp())) RETURNING *`,
    )
  ).rows[0];
  return row ?? null;
}
export function startJobHeartbeat(db: Database, job: Row) {
  const timer = setInterval(() => {
    void db
      .execute(
        sql`UPDATE durable_jobs SET lease_until=clock_timestamp()+interval '60 seconds',updated_at=now() WHERE id=${job.id as string} AND status='running' AND lease_owner=${job.lease_owner as string} AND lease_epoch=${Number(job.lease_epoch)} AND lease_until>clock_timestamp()`,
      )
      .catch(() => {});
  }, 10000);
  return () => clearInterval(timer);
}
export async function assertJob(tx: DatabaseExecutor, job: Row) {
  const result = await tx.execute(
    sql`SELECT id FROM durable_jobs WHERE id=${job.id as string} AND lease_epoch=${Number(job.lease_epoch)} AND lease_owner=${job.lease_owner as string} AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`,
  );
  if (!result.rows.length)
    throw new AppError('INVALID_STATE', '作业租约已失效。');
}
export async function finishJob(
  tx: DatabaseExecutor,
  job: Row,
  status: 'succeeded' | 'failed',
  code: string | null = null,
) {
  await assertJob(tx, job);
  await tx.execute(
    sql`UPDATE durable_jobs SET status=${status},error_code=${code},lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=${job.id as string}`,
  );
}
