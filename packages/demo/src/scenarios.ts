import { randomUUID } from 'node:crypto';
import {
  DemoJourneyIdSchema,
  StartDemoJourneySchema,
  DemoJourneyMetadataEvidenceSchema,
  type DemoJourneyMetadataEvidence,
} from '@caixiaozhi/contracts/demo-scenarios';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import type {
  DemoJourneyReport,
  DemoJourneyRunnerOptions,
  DemoJourneyId,
} from './journeys.js';
export function createDemoScenarioController(
  database: DatabaseConnection,
  options: {
    appMode: 'demo' | 'test' | 'production';
    environmentId: string;
    freshActor: (actor: ActorContext) => Promise<ActorContext>;
    run: (
      scenario: DemoJourneyId,
      hooks: Pick<
        DemoJourneyRunnerOptions,
        'onEvidence' | 'heartbeat' | 'signal'
      >,
    ) => Promise<DemoJourneyReport>;
  },
) {
  const active = new Map<string, AbortController>();
  function enabled() {
    if (options.appMode !== 'demo')
      throw new AppError('FORBIDDEN', '仅显式演示模式可以运行合成旅程。');
  }
  async function authorize(actor: ActorContext) {
    enabled();
    const current = await options.freshActor(actor);
    if (!current.permissions.includes('demo.control'))
      throw new AppError('FORBIDDEN', '没有演示旅程控制权限。');
    return current;
  }
  async function start(
    actor: ActorContext,
    scenarioInput: string,
    input: unknown,
    key: string,
  ) {
    actor = await authorize(actor);
    const scenario = DemoJourneyIdSchema.parse(scenarioInput),
      parsed = StartDemoJourneySchema.parse(input);
    if (!key || key.length > 200)
      throw new AppError('VALIDATION_ERROR', '旅程启动需要有效的幂等键。');
    const hash = canonicalHash({ scenario, ...parsed });
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['demo-write:' + options.environmentId],
      );
      const env = (
        await client.query(
          'SELECT * FROM demo_environments WHERE id=$1 FOR UPDATE',
          [options.environmentId],
        )
      ).rows[0];
      if (!env || env.active_tenant_id !== actor.tenant_id)
        throw new AppError('NOT_FOUND', '演示环境不存在或会话已过期。');
      const operation = `demo.journey.start:${scenario}`;
      const prior = (
        await client.query(
          'SELECT payload_hash,result FROM demo_control_commands WHERE env_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',
          [options.environmentId, actor.user_id, operation, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '同一幂等键的旅程范围已变化。',
          );
        await client.query('COMMIT');
        return prior.result;
      }
      if (
        env.lifecycle !== 'ready' ||
        env.active_generation !== parsed.expected_generation ||
        env.version !== parsed.expected_environment_version
      )
        throw new AppError(
          'VERSION_CONFLICT',
          '环境已更新或尚未就绪，请刷新后重新审阅。',
        );
      const open = await client.query(
        "SELECT id FROM demo_scenario_runs WHERE env_id=$1 AND state IN('queued','running') AND scenario_id LIKE 'E2E-%'",
        [options.environmentId],
      );
      if (open.rowCount)
        throw new AppError(
          'INVALID_STATE',
          '已有隔离旅程正在运行，请先查看原任务。',
        );
      const result = (
        await client.query(
          "INSERT INTO demo_scenario_runs(id,env_id,generation,scenario_id,state,requested_by) VALUES($1,$2,$3,$4,'queued',$5) RETURNING id,scenario_id,state,generation,version",
          [
            randomUUID(),
            options.environmentId,
            env.active_generation,
            scenario,
            actor.user_id,
          ],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO demo_control_commands(env_id,actor_id,operation,key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
        [
          options.environmentId,
          actor.user_id,
          operation,
          key,
          hash,
          JSON.stringify(result),
        ],
      );
      await client.query(
        'INSERT INTO demo_control_audit(id,env_id,actor_id,operation,before_generation,after_generation,job_id,trace_id) VALUES($1,$2,$3,$4,$5,$5,$6,$7)',
        [
          randomUUID(),
          options.environmentId,
          actor.user_id,
          operation,
          env.active_generation,
          result.id,
          randomUUID(),
        ],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function get(actor: ActorContext, id: string) {
    actor = await authorize(actor);
    const result = await database.pool.query(
      'SELECT s.id,s.scenario_id,s.state,s.generation,s.baseline_generation,s.outcome,s.error_code,s.evidence,s.version,s.created_at,s.finished_at FROM demo_scenario_runs s JOIN demo_environments e ON e.id=s.env_id WHERE s.env_id=$1 AND s.id=$2 AND e.active_tenant_id=$3',
      [options.environmentId, id, actor.tenant_id],
    );
    if (!result.rowCount) throw new AppError('NOT_FOUND', '场景记录不存在。');
    const row = result.rows[0];
    const evidence = Array.isArray(row.evidence)
      ? row.evidence.flatMap((input: unknown) => {
          if (!input || typeof input !== 'object' || Array.isArray(input))
            return [];
          const value = input as Record<string, unknown>,
            safe = DemoJourneyMetadataEvidenceSchema.safeParse({
              step_id: value.step_id,
              passed: value.passed,
              trace_id: value.trace_id,
              resource_refs: value.resource_refs,
              occurred_at: value.occurred_at,
            });
          return safe.success ? [safe.data] : [];
        })
      : [];
    return { ...row, evidence };
  }
  async function processNext(workerId: string) {
    enabled();
    const row = (
      await database.pool.query(
        "WITH candidate AS(SELECT id FROM demo_scenario_runs WHERE env_id=$1 AND scenario_id LIKE 'E2E-%' AND (state='queued' OR (state='running' AND lease_until<clock_timestamp())) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE demo_scenario_runs s SET state='running',lease_owner=$2,lease_epoch=s.lease_epoch+1,lease_until=clock_timestamp()+interval '30 seconds',version=s.version+1,updated_at=now() FROM candidate c WHERE s.id=c.id RETURNING s.*",
        [options.environmentId, workerId],
      )
    ).rows[0];
    if (!row) return false;
    const controller = new AbortController();
    active.set(row.id, controller);
    const heartbeat = async () => {
      const live = await database.pool.query(
        "UPDATE demo_scenario_runs SET lease_until=clock_timestamp()+interval '30 seconds',updated_at=now() WHERE id=$1 AND env_id=$2 AND state='running' AND lease_owner=$3 AND lease_epoch=$4 AND lease_until>clock_timestamp() RETURNING id",
        [row.id, options.environmentId, workerId, row.lease_epoch],
      );
      if (!live.rowCount) {
        controller.abort();
        throw new AppError('INVALID_STATE', '隔离旅程租约已失效。');
      }
    };
    const timer = setInterval(
      () => void heartbeat().catch(() => controller.abort()),
      10000,
    );
    try {
      const onEvidence = async (input: DemoJourneyMetadataEvidence) => {
        await heartbeat();
        const safe = DemoJourneyMetadataEvidenceSchema.parse({
          step_id: input.step_id,
          passed: input.passed,
          trace_id: input.trace_id,
          resource_refs: input.resource_refs,
          occurred_at: input.occurred_at,
        });
        await database.pool.query(
          "UPDATE demo_scenario_runs SET evidence=evidence||$5::jsonb,version=version+1,updated_at=now() WHERE id=$1 AND env_id=$2 AND lease_owner=$3 AND lease_epoch=$4 AND state='running' AND lease_until>clock_timestamp()",
          [
            row.id,
            options.environmentId,
            workerId,
            row.lease_epoch,
            JSON.stringify([safe]),
          ],
        );
      };
      const report = await options.run(
        DemoJourneyIdSchema.parse(row.scenario_id),
        { onEvidence, heartbeat, signal: controller.signal },
      );
      await heartbeat();
      await database.pool.query(
        "UPDATE demo_scenario_runs SET state=$5,outcome=$6,error_code=$7,baseline_generation=$8,finished_at=now(),lease_until=NULL,lease_owner=NULL,version=version+1 WHERE id=$1 AND env_id=$2 AND lease_owner=$3 AND lease_epoch=$4 AND state='running' AND lease_until>clock_timestamp()",
        [
          row.id,
          options.environmentId,
          workerId,
          row.lease_epoch,
          report.status === 'succeeded' ? 'passed' : 'failed',
          report.status,
          report.error?.code ?? null,
          report.baseline?.generation ?? null,
        ],
      );
    } catch (error) {
      await database.pool.query(
        "UPDATE demo_scenario_runs SET state='failed',outcome=$5,error_code=$6,finished_at=now(),lease_until=NULL,lease_owner=NULL,version=version+1 WHERE id=$1 AND env_id=$2 AND lease_owner=$3 AND lease_epoch=$4 AND state='running' AND lease_until>clock_timestamp()",
        [
          row.id,
          options.environmentId,
          workerId,
          row.lease_epoch,
          controller.signal.aborted ? 'cancelled' : 'failed',
          error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
        ],
      );
    } finally {
      clearInterval(timer);
      active.delete(row.id);
    }
    return true;
  }
  return {
    start,
    get,
    processNext,
    stop() {
      for (const controller of active.values()) controller.abort();
    },
  };
}
export type DemoScenarioController = ReturnType<
  typeof createDemoScenarioController
>;
