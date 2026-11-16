import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
export type ModelSlotLease = {
  id: string;
  tenant_id: string;
  owner_id: string;
  kind: 'agent_run' | 'generation' | 'skill_validation';
  reference_id: string;
  owner_epoch: number;
  lease_owner: string;
  lease_epoch: number;
  lease_until: string;
};
export type ModelSlotInput = Omit<
  ModelSlotLease,
  'id' | 'lease_epoch' | 'lease_until'
> & { lease_ms?: number };
const leaseDto = (row: Record<string, any>): ModelSlotLease => ({
  id: row.id,
  tenant_id: row.tenant_id,
  owner_id: row.owner_id,
  kind: row.kind,
  reference_id: row.reference_id,
  owner_epoch: Number(row.owner_epoch),
  lease_owner: row.lease_owner,
  lease_epoch: Number(row.lease_epoch),
  lease_until: new Date(row.lease_until).toISOString(),
});
export function createModelSlotService(
  database: DatabaseConnection,
  limits: { userSlots?: number; tenantSlots?: number } = {},
) {
  return {
    async acquire(input: ModelSlotInput): Promise<ModelSlotLease | null> {
      if (
        !Number.isSafeInteger(input.owner_epoch) ||
        input.owner_epoch < 0 ||
        !input.tenant_id ||
        !input.owner_id ||
        !input.reference_id ||
        !input.lease_owner
      )
        throw new AppError('VALIDATION_ERROR', '模型槽申请无效。');
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`model-slots:${input.tenant_id}`],
        );
        const key = JSON.stringify([
          input.tenant_id,
          input.kind,
          input.reference_id,
          input.owner_epoch,
        ]);
        const old = await client.query(
          'SELECT *,lease_until>clock_timestamp() AND released_at IS NULL AS live FROM model_slots WHERE occupant_key=$1 FOR UPDATE',
          [key],
        );
        if (old.rows[0]) {
          if (old.rows[0].owner_id !== input.owner_id)
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '该模型运行标识已属于其他用户。',
            );
          if (old.rows[0].live) {
            await client.query('COMMIT');
            return old.rows[0].lease_owner === input.lease_owner
              ? leaseDto(old.rows[0])
              : null;
          }
        }
        const usage = await client.query(
          'SELECT count(*)::int tenant_active,count(*) FILTER(WHERE owner_id=$2)::int user_active FROM model_slots WHERE tenant_id=$1 AND released_at IS NULL AND lease_until>clock_timestamp()',
          [input.tenant_id, input.owner_id],
        );
        if (
          usage.rows[0].user_active >= (limits.userSlots ?? 2) ||
          usage.rows[0].tenant_active >= (limits.tenantSlots ?? 20)
        ) {
          await client.query('COMMIT');
          return null;
        }
        const result = await client.query(
          `INSERT INTO model_slots(id,occupant_key,tenant_id,owner_id,kind,reference_id,owner_epoch,lease_owner,lease_epoch,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,clock_timestamp()+$9*interval '1 millisecond') ON CONFLICT(occupant_key) DO UPDATE SET lease_owner=$8,lease_epoch=model_slots.lease_epoch+1,lease_until=clock_timestamp()+$9*interval '1 millisecond',heartbeat_at=now(),released_at=NULL RETURNING *`,
          [
            randomUUID(),
            key,
            input.tenant_id,
            input.owner_id,
            input.kind,
            input.reference_id,
            input.owner_epoch,
            input.lease_owner,
            input.lease_ms ?? 30000,
          ],
        );
        await client.query('COMMIT');
        return leaseDto(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async assert(lease: ModelSlotLease): Promise<void> {
      const result = await database.pool.query(
        'SELECT 1 FROM model_slots WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND owner_epoch=$4 AND tenant_id=$5 AND owner_id=$6 AND released_at IS NULL AND lease_until>clock_timestamp()',
        [
          lease.id,
          lease.lease_owner,
          lease.lease_epoch,
          lease.owner_epoch,
          lease.tenant_id,
          lease.owner_id,
        ],
      );
      if (!result.rowCount)
        throw new AppError(
          'INVALID_STATE',
          '模型执行槽租约已失效，已停止生成。',
          { details: { reason: 'MODEL_SLOT_LEASE_LOST' } },
        );
    },
    async heartbeat(lease: ModelSlotLease, leaseMs = 30000): Promise<void> {
      const result = await database.pool.query(
        "UPDATE model_slots SET lease_until=clock_timestamp()+$4*interval '1 millisecond',heartbeat_at=now() WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND released_at IS NULL AND lease_until>clock_timestamp() RETURNING id",
        [lease.id, lease.lease_owner, lease.lease_epoch, leaseMs],
      );
      if (!result.rowCount)
        throw new AppError('INVALID_STATE', '模型执行槽租约已失效。', {
          details: { reason: 'MODEL_SLOT_LEASE_LOST' },
        });
    },
    async release(lease: ModelSlotLease): Promise<void> {
      await database.pool.query(
        'UPDATE model_slots SET lease_until=now(),released_at=COALESCE(released_at,now()) WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3',
        [lease.id, lease.lease_owner, lease.lease_epoch],
      );
    },
  };
}
export type ModelSlotService = ReturnType<typeof createModelSlotService>;
