import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { ActorContext } from '@caixiaozhi/contracts';
import type {
  DatabaseConnection,
  Transaction,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
export function createDemoAccessGate(
  database: DatabaseConnection,
  appMode: 'demo' | 'test' | 'production',
) {
  const check = (
    row: Record<string, any> | undefined,
    scope: { tenant_id: string; generation?: number; write_fence?: number },
  ) => {
    if (!row) return; // 无受控环境的独立测试租户由正常身份/领域权限保护。
    if (
      row.active_tenant_id !== scope.tenant_id ||
      row.lifecycle !== 'ready' ||
      (scope.generation !== undefined &&
        row.active_generation !== scope.generation) ||
      (scope.write_fence !== undefined &&
        Number(row.write_fence) !== scope.write_fence)
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '演示环境已更新或正在维护，请重新选择身份。',
        { details: { reason: 'DEMO_GENERATION_CHANGED' } },
      );
  };
  return {
    async currentTenant(envId = 'demo-default') {
      if (appMode === 'production')
        throw new AppError('FORBIDDEN', '生产环境不提供演示控制。');
      const result = await database.pool.query(
        'SELECT active_tenant_id,active_generation,write_fence,lifecycle FROM demo_environments WHERE id=$1',
        [envId],
      );
      if (!result.rows[0])
        return { tenant_id: 't-demo', generation: 1, write_fence: 1 };
      return {
        tenant_id: result.rows[0].active_tenant_id as string,
        generation: Number(result.rows[0].active_generation),
        write_fence: Number(result.rows[0].write_fence),
      };
    },
    async assertCurrentActor(actor: ActorContext) {
      if (appMode === 'production') return;
      const result = await database.pool.query(
        'SELECT e.* FROM demo_environments e LEFT JOIN demo_generation_manifests g ON g.env_id=e.id WHERE e.active_tenant_id=$1 OR g.namespace_ref=$1 LIMIT 1',
        [actor.tenant_id],
      );
      check(result.rows[0], actor);
    },
    async assertGenerationWritable(
      transaction: Transaction | PoolClient,
      scope: { tenant_id: string; generation?: number; write_fence?: number },
    ) {
      if (appMode === 'production') return;
      const result =
        typeof (transaction as PoolClient).query === 'function'
          ? await (transaction as PoolClient).query(
              'SELECT e.* FROM demo_environments e WHERE e.active_tenant_id=$1 OR EXISTS(SELECT 1 FROM demo_generation_manifests g WHERE g.env_id=e.id AND g.namespace_ref=$1) FOR SHARE OF e',
              [scope.tenant_id],
            )
          : await (transaction as Transaction).execute(
              sql`SELECT e.* FROM demo_environments e WHERE e.active_tenant_id=${scope.tenant_id} OR EXISTS(SELECT 1 FROM demo_generation_manifests g WHERE g.env_id=e.id AND g.namespace_ref=${scope.tenant_id}) FOR SHARE OF e`,
            );
      check(result.rows[0] as Record<string, any> | undefined, scope);
    },
  };
}
