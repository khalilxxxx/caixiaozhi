import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { DEFAULT_LEASE_MS } from './lease.js';
import type { Transaction } from '@caixiaozhi/platform/database';
import { sql } from 'drizzle-orm';

export type DurableJob = {
  id: string;
  tenant_id: string;
  owner_module: string;
  kind: string;
  payload_ref: string;
  dedupe_key: string;
  status: 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  generation: number;
  lease_epoch: number;
  lease_owner: string | null;
};
export type EnqueueJob = Pick<
  DurableJob,
  'tenant_id' | 'owner_module' | 'kind' | 'payload_ref' | 'dedupe_key'
> & { generation?: number; ready_at?: Date };

export async function enqueueInTransaction(
  transaction: Transaction,
  input: EnqueueJob,
): Promise<DurableJob> {
  const result =
    await transaction.execute(sql`INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation,ready_at)
    VALUES(${randomUUID()},${input.tenant_id},${input.owner_module},${input.kind},${input.payload_ref},${input.dedupe_key},${input.generation ?? 0},${input.ready_at ?? new Date()})
    ON CONFLICT(tenant_id,kind,dedupe_key) DO UPDATE SET dedupe_key=durable_jobs.dedupe_key RETURNING *`);
  const job = result.rows[0] as DurableJob;
  if (
    job.payload_ref !== input.payload_ref ||
    job.owner_module !== input.owner_module ||
    job.generation !== (input.generation ?? 0)
  )
    throw new AppError('IDEMPOTENCY_CONFLICT', '作业去重键已用于不同内容。');
  return { ...job, lease_epoch: Number(job.lease_epoch) };
}

/** 领域作业独立于模型队列，完全不占 dsh 槽。payload_ref 必须引用服务端已有对象。 */
export function createDurableQueue(database: DatabaseConnection) {
  return {
    enqueueInTransaction,
    async enqueue(input: EnqueueJob): Promise<DurableJob> {
      const result = await database.pool.query(
        `INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation,ready_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,kind,dedupe_key)
         DO UPDATE SET dedupe_key=durable_jobs.dedupe_key RETURNING *`,
        [
          randomUUID(),
          input.tenant_id,
          input.owner_module,
          input.kind,
          input.payload_ref,
          input.dedupe_key,
          input.generation ?? 0,
          input.ready_at ?? new Date(),
        ],
      );
      const job = result.rows[0] as DurableJob;
      if (
        job.payload_ref !== input.payload_ref ||
        job.owner_module !== input.owner_module ||
        job.generation !== (input.generation ?? 0)
      )
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '作业去重键已用于不同内容。',
        );
      return { ...job, lease_epoch: Number(job.lease_epoch) };
    },
    async claim(
      workerId: string,
      kinds: string[],
      leaseMs = DEFAULT_LEASE_MS,
      scope: { tenant_id?: string; payload_ref?: string } = {},
    ): Promise<DurableJob | null> {
      const result = await database.pool.query(
        `WITH candidate AS (
           SELECT id FROM durable_jobs WHERE kind=ANY($2::text[]) AND ready_at<=now()
           AND ($4::text IS NULL OR tenant_id=$4) AND ($5::text IS NULL OR payload_ref=$5)
           AND (status='ready' OR (status='running' AND lease_until<now()))
           ORDER BY ready_at,id FOR UPDATE SKIP LOCKED LIMIT 1
         ) UPDATE durable_jobs j SET status='running',lease_owner=$1,lease_epoch=j.lease_epoch+1,
           lease_until=clock_timestamp()+$3*interval '1 millisecond',attempt=j.attempt+1,version=j.version+1,updated_at=now()
           FROM candidate c WHERE j.id=c.id RETURNING j.*`,
        [
          workerId,
          kinds,
          leaseMs,
          scope.tenant_id ?? null,
          scope.payload_ref ?? null,
        ],
      );
      const row = result.rows[0] as DurableJob | undefined;
      return row ? { ...row, lease_epoch: Number(row.lease_epoch) } : null;
    },
    async heartbeat(
      id: string,
      workerId: string,
      epoch: number,
      leaseMs = DEFAULT_LEASE_MS,
    ) {
      const result = await database.pool.query(
        `UPDATE durable_jobs SET lease_until=clock_timestamp()+$4*interval '1 millisecond',updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() RETURNING id`,
        [id, workerId, epoch, leaseMs],
      );
      if (!result.rowCount)
        throw new AppError('INVALID_STATE', '作业租约已失效。', {
          details: { reason: 'LEASE_LOST' },
        });
    },
    async finish(
      id: string,
      workerId: string,
      epoch: number,
      status: 'succeeded' | 'failed',
      errorCode: string | null = null,
    ) {
      const result = await database.pool.query(
        `UPDATE durable_jobs SET status=$4,error_code=$5,lease_until=NULL,lease_owner=NULL,
        version=version+1,updated_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3
        AND status='running' AND lease_until>clock_timestamp() RETURNING id`,
        [id, workerId, epoch, status, errorCode],
      );
      if (!result.rowCount)
        throw new AppError('INVALID_STATE', '作业租约已失效。', {
          details: { reason: 'LEASE_LOST' },
        });
    },
    async cancelTenantGeneration(tenantId: string, generation: number) {
      await database.pool.query(
        `UPDATE durable_jobs SET status='cancelled',lease_epoch=lease_epoch+1,lease_until=NULL,
        lease_owner=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND generation=$2 AND status IN ('ready','running')`,
        [tenantId, generation],
      );
    },
  };
}
