import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';

export const DEFAULT_LEASE_MS = 30000;
export const DEFAULT_HEARTBEAT_MS = 10000;

/** 同一对象只能有一个所有权来源；Agent 的所有权仅以 run_leases 为准。 */
export async function assertRunLease(
  database: DatabaseConnection,
  runId: string,
  epoch: number,
): Promise<void> {
  const result = await database.pool.query(
    `SELECT 1 FROM run_leases l JOIN agent_runs r ON r.id=l.run_id
     WHERE l.run_id=$1 AND l.lease_epoch=$2 AND l.lease_until>clock_timestamp()
     AND r.status='running' AND r.runtime_active AND r.cancel_requested_at IS NULL`,
    [runId, epoch],
  );
  if (!result.rowCount)
    throw new AppError('INVALID_STATE', '任务租约已失效，已停止后续步骤。', {
      details: { reason: 'LEASE_LOST' },
    });
}
