import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { DemoService } from '@caixiaozhi/demo';
import type { DemoFaultKind } from '@caixiaozhi/contracts/demo';
import type { RunCheckpoint } from '@caixiaozhi/contracts/runs';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import type { InvoiceFields } from '@caixiaozhi/contracts/expenses';
import type { ActionHandler } from '@caixiaozhi/business-adapters/ports';

export type FaultScope = { tenant_id: string; resource_ids: string[] };
/** 只有实际接线的调用点才列入 enabledKinds；未接入的故障无法在控制台 armed。 */
export function createApplicationFaults(
  database: DatabaseConnection,
  demo: DemoService,
  options: { enabledKinds: DemoFaultKind[] },
) {
  const enabled = new Set(options.enabledKinds);
  for (const kind of enabled) demo.registerFaultConsumer(kind);
  async function aliases(scope: FaultScope) {
    const result = await database.pool.query(
      `SELECT g.manifest FROM demo_environments e JOIN demo_generation_manifests g ON g.env_id=e.id AND g.generation=e.active_generation WHERE e.active_tenant_id=$1 AND e.lifecycle='ready'`,
      [scope.tenant_id],
    );
    const map = (result.rows[0]?.manifest?.alias_map ?? {}) as Record<
      string,
      string
    >;
    return Object.entries(map)
      .filter(
        ([alias, id]) =>
          scope.resource_ids.includes(id) || scope.resource_ids.includes(alias),
      )
      .map(([alias]) => alias);
  }
  async function hit(kind: DemoFaultKind, scope: FaultScope) {
    if (!enabled.has(kind)) return false;
    for (const alias of await aliases(scope)) {
      if (await demo.consumeFault(scope.tenant_id, kind, alias)) return true;
    }
    return false;
  }
  return {
    aliases,
    hit,
    supportedKinds: [...enabled],
    async beforeOcr(scope: FaultScope) {
      if (await hit('ocr.timeout', scope))
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '演示票据识别提供方超时，请从任务记录重试。',
          { retryable: true, details: { reason: 'DEMO_OCR_TIMEOUT' } },
        );
    },
    async ocrCandidates(
      scope: FaultScope,
      candidates: InvoiceFields[],
    ): Promise<InvoiceFields[]> {
      if (!(await hit('ocr.low_confidence', scope))) return candidates;
      return candidates.map((candidate) => ({
        ...candidate,
        invoice_kind: 'other',
        expense_type: null,
      }));
    },
    async preauditRead<T>(
      scope: FaultScope,
      read: () => Promise<T>,
    ): Promise<T> {
      if (await hit('preaudit.check_unavailable', scope))
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '演示必查资料读取暂不可用。',
          {
            retryable: true,
            details: { reason: 'DEMO_PREAUDIT_CHECK_UNAVAILABLE' },
          },
        );
      return read();
    },
    async beforeReadTool(scope: FaultScope) {
      if (await hit('maas.read_unavailable', scope))
        throw new AppError('DEPENDENCY_UNAVAILABLE', '演示只读能力暂不可用。', {
          retryable: true,
          details: { reason: 'DEMO_READ_UNAVAILABLE' },
        });
    },
    async disconnectSse(scope: FaultScope) {
      return hit('sse.disconnect_once', scope);
    },
    async interruptAtCheckpoint(
      scope: FaultScope,
      checkpoint: RunCheckpoint,
    ): Promise<RunCheckpoint | null> {
      return (await hit('worker.interrupt_once', scope))
        ? CheckpointSchema.parse({
            ...checkpoint,
            stage: 'interrupted',
            recovery_mode: 'application_checkpoint',
          })
        : null;
    },
    wrapCommittedResponseLoss<A>(handler: ActionHandler<A>): ActionHandler<A> {
      // 演示隔离远端语义：先真实提交一次领域事务，随后才模拟回包丢失。
      // 不能在领域事务里抛错，否则只验证回滚，根本没有“提交成功回包丢失”。
      return {
        mode: 'remote',
        validate: (actor, args, refs, tx) =>
          handler.validate(actor, args, refs, tx),
        execute: async (ctx, _outer, action) => {
          let receipt;
          if (handler.mode === 'remote')
            receipt = await handler.execute(ctx, null, action);
          else {
            let bodyFailure: unknown;
            try {
              receipt = await database.db.transaction(async (transaction) => {
                try {
                  await handler.validate(
                    ctx.actor,
                    (action.item.args ?? action.args) as A,
                    action.resource_refs,
                    transaction,
                  );
                  return await handler.execute(ctx, transaction, action);
                } catch (error) {
                  bodyFailure = error;
                  throw error;
                }
              });
            } catch (error) {
              // 仅原回调错误被完整回滚后重新抛出才能证明未提交；COMMIT/ROLLBACK网络故障保持unknown语义。
              if (
                error === bodyFailure &&
                error instanceof AppError &&
                !['DEPENDENCY_UNAVAILABLE', 'OUTCOME_UNKNOWN'].includes(
                  error.code,
                )
              )
                throw new AppError(error.code, error.message, {
                  retryable: error.retryable,
                  details: { ...error.details, effect_not_started: true },
                });
              throw error;
            }
          }
          const scope = {
            tenant_id: ctx.actor.tenant_id,
            resource_ids: [
              ctx.actor.user_id,
              ...action.resource_refs.map((ref) => ref.id),
            ],
          };
          if (
            (await hit('action.response_lost_after_commit', scope)) ||
            (await hit('adapter.write_outcome_unknown', scope))
          )
            throw new AppError(
              'OUTCOME_UNKNOWN',
              '演示业务已经提交，回包未取得，请查询原动作回执。',
              { details: { reason: 'DEMO_RESPONSE_LOST_AFTER_COMMIT' } },
            );
          return receipt;
        },
        queryOutcome: (ctx, action) => handler.queryOutcome(ctx, action),
      };
    },
  };
}
export type ApplicationFaults = ReturnType<typeof createApplicationFaults>;
