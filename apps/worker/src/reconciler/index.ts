import type { RunService } from '@caixiaozhi/agent-runtime';
import type { ActionService } from '@caixiaozhi/action-service';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
/** 启动与周期巡检只恢复安全的只读执行；未知写入只进入 reconciling，由 M11 核实回执。 */
export function createRunReconciler(runs: RunService) {
  return { tick: () => runs.recoverExpired() };
}

/** 与模型/OCR主循环分开调度；每tick只领取一个原动作的回执查询，再有界恢复关联run。 */
export function createReceiptReconciler(options: {
  database: DatabaseConnection;
  actions: ActionService;
  runs: RunService;
}) {
  let busy = false;
  return {
    async tick(
      workerId: string,
      scope: { tenant_id?: string; action_id?: string } = {},
    ) {
      if (busy) return;
      busy = true;
      try {
        await options.actions.processNextReconciliation(workerId, scope);
        const selected = await options.database.pool.query(
          "SELECT r.id FROM agent_runs r WHERE r.status='reconciling' AND ($1::text IS NULL OR r.tenant_id=$1) AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.run_id=r.id AND t.action_id=$2)) ORDER BY r.updated_at,r.id LIMIT 20",
          [scope.tenant_id ?? null, scope.action_id ?? null],
        );
        for (const row of selected.rows) {
          try {
            await options.runs.reconcileRun(row.id, async (actor, actionId) => {
              const action = await options.actions.getAction(actor, actionId),
                pending = [
                  'prepared',
                  'confirmed',
                  'executing',
                  'unknown',
                ].includes(action.state);
              return {
                status: pending ? 'unknown' : 'ok',
                data: action,
                evidence_refs: [`action:${action.id}`],
                action_id: action.id,
                error_code: pending ? 'OUTCOME_UNKNOWN' : null,
              };
            });
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
          }
        }
      } finally {
        busy = false;
      }
    },
  };
}
