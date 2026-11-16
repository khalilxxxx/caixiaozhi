import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ActorContext } from '@caixiaozhi/contracts';
import {
  DEMO_SEED_VERSION,
  DemoManifestSchema,
  DemoScenarioSchema,
  ResetDemoSchema,
  DemoFaultSchema,
  type DemoFaultKind,
  type DemoManifest,
  type DemoScenario,
} from '@caixiaozhi/contracts/demo';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { createDemoAccessGate } from './gate.js';
type Row = Record<string, any>;
export type SeedEnvironmentInput = {
  tenantId: string;
  environmentId: string;
  generation: number;
  scenarioId: DemoScenario;
  seedVersion: typeof DEMO_SEED_VERSION;
};
export type DemoServiceOptions = {
  appMode: 'demo' | 'test' | 'production';
  environmentId?: string;
  logicalTenantId?: string;
  identity?: {
    requireCurrentActor: (actor: ActorContext) => Promise<ActorContext>;
  };
  freshActor?: (actor: ActorContext) => Promise<ActorContext>;
  seedEnvironment: (input: SeedEnvironmentInput) => Promise<unknown>;
  reconcileActions?: (tenantId: string) => Promise<void>;
  triggerSubscriptions?: (
    tenantId: string,
    at: Date,
    subscriptionId?: string,
  ) => Promise<{ enqueued: number; [key: string]: unknown }>;
  verifyEnvironment?: (input: SeedEnvironmentInput) => Promise<void>;
};
const canonical = (input: unknown): string =>
  input !== null && typeof input === 'object'
    ? Array.isArray(input)
      ? `[${input.map(canonical).join(',')}]`
      : `{${Object.keys(input)
          .sort()
          .map(
            (key) => `${JSON.stringify(key)}:${canonical((input as Row)[key])}`,
          )
          .join(',')}}`
    : (JSON.stringify(input) ?? 'null');
const hash = (input: unknown) =>
  createHash('sha256').update(canonical(input)).digest('hex');
const scenarios = [
  { id: 'baseline', title: '基准数据' },
  { id: 'rule-creation', title: '个人规则创建' },
  { id: 'E2E-01', title: '制度问答与来源' },
  { id: 'E2E-02', title: '差旅草稿与手改' },
  { id: 'E2E-03', title: '发票到报销' },
  { id: 'E2E-04', title: '个人规则' },
  { id: 'E2E-05', title: '低风险审批' },
  { id: 'E2E-06', title: '分析与报告' },
  { id: 'E2E-07', title: '记忆隔离' },
  { id: 'E2E-08', title: '日报收件箱' },
];
export function createDemoService(
  database: DatabaseConnection,
  options: DemoServiceOptions,
) {
  const envId = options.environmentId ?? 'demo-default';
  const logicalTenant = options.logicalTenantId ?? 't-demo';
  const queue = createDurableQueue(database);
  const gate = createDemoAccessGate(database, options.appMode);
  const supportedFaults = new Set<DemoFaultKind>();
  function enabled() {
    if (options.appMode === 'production')
      throw new AppError('FORBIDDEN', '生产环境不提供演示控制。', {
        details: { reason: 'DEMO_DISABLED' },
      });
  }
  async function tx<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function actorCurrent(actor: ActorContext) {
    enabled();
    const fresh =
      options.freshActor ??
      options.identity?.requireCurrentActor.bind(options.identity);
    if (!fresh)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '演示身份服务尚未就绪。');
    const current = await fresh(actor);
    if (!current.permissions.includes('demo.control'))
      throw new AppError('FORBIDDEN', '没有演示环境控制权限。');
    return current;
  }
  async function environment(
    client: Pick<PoolClient, 'query'> = database.pool,
    lock = false,
  ) {
    const result = await client.query(
      `SELECT * FROM demo_environments WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [envId],
    );
    if (!result.rows[0])
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '演示环境尚未初始化，请运行受控 seed。',
      );
    return result.rows[0] as Row;
  }
  function view(row: Row) {
    return {
      id: row.id,
      logical_tenant_id: row.logical_tenant_id,
      active_tenant_id: row.active_tenant_id,
      generation: row.active_generation,
      write_fence: Number(row.write_fence),
      lifecycle: row.lifecycle,
      version: row.version,
      seed_version: row.seed_version,
      manifest_hash: row.manifest_hash,
      business_now: new Date(row.business_now).toISOString(),
      timezone: row.timezone,
      clock_version: row.clock_version,
      data_mode: 'demo' as const,
    };
  }
  function guard(
    row: Row,
    input: {
      expected_generation: number;
      expected_environment_version: number;
    },
  ) {
    if (
      row.active_generation !== input.expected_generation ||
      row.version !== input.expected_environment_version
    )
      throw new AppError('VERSION_CONFLICT', '演示环境已更新，请刷新控制台。', {
        details: {
          current_generation: row.active_generation,
          current_environment_version: row.version,
        },
      });
  }
  async function audit(
    client: PoolClient,
    actorId: string,
    operation: string,
    before: number,
    after: number,
    jobId: string | null = null,
  ) {
    await client.query(
      'INSERT INTO demo_control_audit(id,env_id,actor_id,operation,before_generation,after_generation,job_id,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        envId,
        actorId,
        operation,
        before,
        after,
        jobId,
        randomUUID(),
      ],
    );
  }
  async function command<T>(
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
    fn: (client: PoolClient, env: Row) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length > 200)
      throw new AppError('VALIDATION_ERROR', '请提供有效的 Idempotency-Key。');
    return tx(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['demo-write:' + envId],
      );
      const env = await environment(client, true);
      if (actor.tenant_id !== env.active_tenant_id)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '演示身份已过期，请重新选择。',
        );
      const old = await client.query(
        'SELECT * FROM demo_control_commands WHERE env_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4',
        [envId, actor.user_id, operation, key],
      );
      if (old.rows[0]) {
        if (old.rows[0].payload_hash !== hash(input))
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '请求标识已用于不同控制内容。',
          );
        return old.rows[0].result as T;
      }
      const result = await fn(client, env);
      await client.query(
        'INSERT INTO demo_control_commands(env_id,actor_id,operation,key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
        [
          envId,
          actor.user_id,
          operation,
          key,
          hash(input),
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }
  async function verify(
    input: SeedEnvironmentInput,
    seedResult: unknown,
  ): Promise<DemoManifest> {
    const counts = await database.pool.query(
      `SELECT (SELECT count(*)::int FROM identities WHERE tenant_id=$1) users,(SELECT count(*)::int FROM expense_claims WHERE tenant_id=$1) claims,(SELECT count(*)::int FROM expense_claims WHERE tenant_id=$1 AND version<>1) changed_versions`,
      [input.tenantId],
    );
    const totals = await database.pool.query(
      `SELECT count(*) FILTER(WHERE state='pending_manager' AND department_id='dept-sales')::int pending_count,
    COALESCE(sum(total_minor) FILTER(WHERE state='pending_manager' AND department_id='dept-sales'),0)::text pending_minor,
    COALESCE(sum(total_minor) FILTER(WHERE state='completed' AND department_id='dept-sales' AND completed_at>='2026-11-01T00:00:00+08:00' AND completed_at<'2026-12-01T00:00:00+08:00'),0)::text sales_completed_minor FROM expense_claims WHERE tenant_id=$1`,
      [input.tenantId],
    );
    const incomplete = await database.pool.query(
      "SELECT c.total_minor::text amount,i.verification_state FROM expense_claims c JOIN expense_items e ON e.tenant_id=c.tenant_id AND e.claim_id=c.id JOIN invoices i ON i.tenant_id=e.tenant_id AND i.id=e.invoice_id WHERE c.tenant_id=$1 AND c.id='clm-004'",
      [input.tenantId],
    );
    const assertions = [
      { name: 'seven_users', passed: counts.rows[0]?.users === 7 },
      { name: 'eleven_claims', passed: counts.rows[0]?.claims === 11 },
      {
        name: 'baseline_versions_one',
        passed: counts.rows[0]?.changed_versions === 0,
      },
      {
        name: 'sales_pending_5_554000',
        passed:
          totals.rows[0]?.pending_count === 5 &&
          totals.rows[0]?.pending_minor === '554000',
      },
      {
        name: 'sales_completed_590000',
        passed: totals.rows[0]?.sales_completed_minor === '590000',
      },
      {
        name: 'clm004_known_amount_unknown_verification',
        passed:
          incomplete.rows[0]?.amount === '90000' &&
          incomplete.rows[0]?.verification_state === 'pending',
      },
    ];
    if (assertions.some((item) => !item.passed))
      throw new AppError('INVALID_STATE', '演示种子未通过完整性验证。', {
        details: {
          reason: 'SEED_VERIFICATION_FAILED',
          failed_assertions: assertions
            .filter((item) => !item.passed)
            .map((item) => item.name),
        },
      });
    await options.verifyEnvironment?.(input);
    const aliases = await database.pool.query(
      'SELECT id FROM identities WHERE tenant_id=$1 UNION SELECT id FROM expense_claims WHERE tenant_id=$1 UNION SELECT id FROM travel_requests WHERE tenant_id=$1 UNION SELECT id FROM entertainment_requests WHERE tenant_id=$1',
      [input.tenantId],
    );
    const provided =
      seedResult && typeof seedResult === 'object'
        ? (seedResult as Row).alias_map
        : {};
    return DemoManifestSchema.parse({
      seed_version: DEMO_SEED_VERSION,
      schema_version: 1,
      alias_map: {
        ...Object.fromEntries(aliases.rows.map((row) => [row.id, row.id])),
        ...(provided ?? {}),
      },
      expected_counts: { users: 7, claims: 11 },
      assertions,
    });
  }
  async function unknownWrites(
    client: Pick<PoolClient, 'query'>,
    tenantId: string,
  ) {
    const result = await client.query(
      `SELECT (SELECT count(*) FROM actions WHERE tenant_id=$1 AND state IN('unknown','executing'))+(SELECT count(*) FROM runtime_tool_calls tc JOIN agent_runs r ON r.id=tc.run_id WHERE r.tenant_id=$1 AND tc.effect='write' AND tc.status IN('unknown','running')) AS n`,
      [tenantId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }
  const service = {
    gate,
    registerFaultConsumer(kind: DemoFaultKind) {
      enabled();
      supportedFaults.add(kind);
    },
    supportedFaultKinds() {
      return [...supportedFaults];
    },
    async initialize() {
      enabled();
      const prior = await database.pool.query(
        'SELECT * FROM demo_environments WHERE id=$1',
        [envId],
      );
      if (prior.rows[0]?.manifest_hash) return view(prior.rows[0]);
      await database.pool.query(
        "INSERT INTO demo_environments(id,logical_tenant_id,active_tenant_id,lifecycle,seed_version) VALUES($1,$2,$2,'resetting',$3) ON CONFLICT(id) DO UPDATE SET lifecycle='resetting'",
        [envId, logicalTenant, DEMO_SEED_VERSION],
      );
      const input: SeedEnvironmentInput = {
        tenantId: logicalTenant,
        environmentId: envId,
        generation: 1,
        scenarioId: 'baseline',
        seedVersion: DEMO_SEED_VERSION,
      };
      try {
        await database.pool.query(
          "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state) VALUES($1,1,$2,$3,'building','{}','building') ON CONFLICT(env_id,generation) DO UPDATE SET state='building'",
          [envId, logicalTenant, DEMO_SEED_VERSION],
        );
        const seed = await options.seedEnvironment(input);
        const manifest = await verify(input, seed);
        return tx(async (client) => {
          await environment(client, true);
          await client.query(
            "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state,verified_at) VALUES($1,1,$2,$3,$4,$5,'active',now()) ON CONFLICT(env_id,generation) DO UPDATE SET manifest=$5,seed_hash=$4,state='active',verified_at=now()",
            [
              envId,
              logicalTenant,
              DEMO_SEED_VERSION,
              hash(manifest),
              JSON.stringify(manifest),
            ],
          );
          const result = await client.query(
            "UPDATE demo_environments SET lifecycle='ready',manifest_hash=$2,updated_at=now() WHERE id=$1 RETURNING *",
            [envId, hash(manifest)],
          );
          await audit(client, 'system', 'demo.initialized', 1, 1);
          return view(result.rows[0]);
        });
      } catch (error) {
        await database.pool.query(
          "UPDATE demo_environments SET lifecycle='failed' WHERE id=$1",
          [envId],
        );
        throw error;
      }
    },
    async current(actor?: ActorContext) {
      enabled();
      if (actor) {
        const fresh =
          options.freshActor ??
          options.identity?.requireCurrentActor.bind(options.identity);
        if (fresh) await fresh(actor);
      }
      return view(await environment());
    },
    async manifest(actor: ActorContext) {
      await actorCurrent(actor);
      const env = await environment();
      const result = await database.pool.query(
        'SELECT manifest,seed_hash FROM demo_generation_manifests WHERE env_id=$1 AND generation=$2',
        [envId, env.active_generation],
      );
      return result.rows[0];
    },
    async requestReset(actor: ActorContext, input: unknown, key: string) {
      actor = await actorCurrent(actor);
      const parsed = ResetDemoSchema.parse(input);
      return command(actor, 'demo.reset', key, parsed, async (client, env) => {
        guard(env, parsed);
        if (env.lifecycle !== 'ready' && env.lifecycle !== 'failed')
          throw new AppError(
            'INVALID_STATE',
            '环境已有维护任务，请查看当前进度。',
          );
        const reserved = await client.query(
          'SELECT GREATEST(COALESCE((SELECT max(generation) FROM demo_generation_manifests WHERE env_id=$1),0),COALESCE((SELECT max(new_generation) FROM demo_reset_jobs WHERE env_id=$1),0))::int value',
          [envId],
        );
        const newGeneration =
          Math.max(
            env.active_generation,
            Number(reserved.rows[0]?.value ?? 0),
          ) + 1;
        const newTenant = `demo-${createHash('sha256').update(envId).digest('hex').slice(0, 12)}-g${newGeneration}-${randomUUID().slice(0, 8)}`;
        const id = randomUUID();
        const result = await client.query(
          "INSERT INTO demo_reset_jobs(id,env_id,old_generation,new_generation,old_tenant_id,new_tenant_id,scenario_id,seed_version,state,phase,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued','stop_admission',$9) RETURNING *",
          [
            id,
            envId,
            env.active_generation,
            newGeneration,
            env.active_tenant_id,
            newTenant,
            parsed.scenario_id,
            parsed.seed_version,
            actor.user_id,
          ],
        );
        await client.query(
          "UPDATE demo_environments SET lifecycle='draining',write_fence=write_fence+1,version=version+1,updated_at=now() WHERE id=$1",
          [envId],
        );
        await client.query(
          "INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation) VALUES($1,$2,'demo','demo.reset',$3,$3,$4)",
          [randomUUID(), env.active_tenant_id, id, env.active_generation],
        );
        await audit(
          client,
          actor.user_id,
          'demo.reset_requested',
          env.active_generation,
          newGeneration,
          id,
        );
        return result.rows[0];
      });
    },
    async getResetJob(actor: ActorContext, id: string) {
      await actorCurrent(actor);
      const result = await database.pool.query(
        'SELECT * FROM demo_reset_jobs WHERE env_id=$1 AND id=$2',
        [envId, id],
      );
      if (!result.rows[0]) throw new AppError('NOT_FOUND', '重建任务不存在。');
      return result.rows[0];
    },
    async resumeReset(
      actor: ActorContext,
      id: string,
      input: {
        expected_generation: number;
        expected_environment_version: number;
      },
      key: string,
    ) {
      actor = await actorCurrent(actor);
      return command(
        actor,
        `demo.resume_reset:${id}`,
        key,
        input,
        async (client, env) => {
          guard(env, input);
          const job = await client.query(
            "SELECT * FROM demo_reset_jobs WHERE id=$1 AND env_id=$2 AND state='blocked' FOR UPDATE",
            [id, envId],
          );
          if (!job.rows[0])
            throw new AppError('INVALID_STATE', '该重建任务当前不能继续。');
          if (await unknownWrites(client, job.rows[0].old_tenant_id))
            throw new AppError(
              'OUTCOME_UNKNOWN',
              '仍有结果待核实的写入，不能重建。',
            );
          await client.query(
            "UPDATE demo_reset_jobs SET state='queued',phase='stop_admission',error_code=NULL,version=version+1 WHERE id=$1",
            [id],
          );
          await client.query(
            "UPDATE durable_jobs SET status='ready',lease_until=NULL,lease_owner=NULL,ready_at=now() WHERE kind='demo.reset' AND payload_ref=$1",
            [id],
          );
          await client.query(
            "UPDATE demo_environments SET lifecycle='draining',version=version+1 WHERE id=$1",
            [envId],
          );
          return { job_id: id, state: 'queued' };
        },
      );
    },
    async runNextReset(workerId = 'demo-control-worker') {
      enabled();
      const candidate = await database.pool.query(
        "SELECT id,old_tenant_id FROM demo_reset_jobs WHERE env_id=$1 AND state IN('queued','running') ORDER BY created_at,id LIMIT 1",
        [envId],
      );
      if (!candidate.rows[0]) return false;
      const lease = await queue.claim(workerId, ['demo.reset'], 30000, {
        tenant_id: candidate.rows[0].old_tenant_id,
        payload_ref: candidate.rows[0].id,
      });
      if (!lease) return false;
      const selected = await database.pool.query(
        'SELECT * FROM demo_reset_jobs WHERE id=$1 AND env_id=$2',
        [lease.payload_ref, envId],
      );
      const job = selected.rows[0];
      if (!job) {
        await queue.finish(
          lease.id,
          workerId,
          lease.lease_epoch,
          'failed',
          'NOT_FOUND',
        );
        return true;
      }
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        heartbeat = setInterval(() => {
          void queue
            .heartbeat(lease.id, workerId, lease.lease_epoch)
            .catch(() => {});
        }, 10000);
        await database.pool.query(
          "UPDATE demo_reset_jobs SET state='running',phase='reconcile_receipts',version=version+1,updated_at=now() WHERE id=$1",
          [job.id],
        );
        await options.reconcileActions?.(job.old_tenant_id);
        if (await unknownWrites(database.pool, job.old_tenant_id)) {
          await tx(async (client) => {
            await client.query(
              "UPDATE demo_reset_jobs SET state='blocked',phase='reconcile_receipts',error_code='OUTCOME_UNKNOWN',version=version+1 WHERE id=$1",
              [job.id],
            );
            await client.query(
              "UPDATE demo_environments SET lifecycle='blocked',version=version+1 WHERE id=$1",
              [envId],
            );
          });
          await queue.finish(
            lease.id,
            workerId,
            lease.lease_epoch,
            'failed',
            'OUTCOME_UNKNOWN',
          );
          return true;
        }
        await tx(async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            ['demo-write:' + envId],
          );
          await environment(client, true);
          await client.query(
            "SELECT set_config('caixiaozhi.demo_control','on',true)",
          );
          await client.query(
            "UPDATE agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),status='cancelled',runtime_active=false,finished_at=now(),version=version+1,error_code='DEMO_GENERATION_RETIRED' WHERE tenant_id=$1 AND status NOT IN('succeeded','failed','cancelled')",
            [job.old_tenant_id],
          );
          await client.query(
            'UPDATE run_leases SET lease_epoch=lease_epoch+1,lease_until=now() WHERE run_id IN(SELECT id FROM agent_runs WHERE tenant_id=$1)',
            [job.old_tenant_id],
          );
          await client.query(
            'DELETE FROM run_jobs WHERE run_id IN(SELECT id FROM agent_runs WHERE tenant_id=$1)',
            [job.old_tenant_id],
          );
          await client.query(
            "UPDATE durable_jobs SET status='cancelled',lease_epoch=lease_epoch+1,lease_until=NULL WHERE tenant_id=$1 AND status IN('ready','running') AND id<>$2",
            [job.old_tenant_id, lease.id],
          );
          await client.query(
            "UPDATE demo_summary_triggers SET status='cancelled',error_code='DEMO_GENERATION_RETIRED',version=version+1,updated_at=now() WHERE env_id=$1 AND tenant_id=$2 AND status IN('queued','running')",
            [envId, job.old_tenant_id],
          );
          await client.query(
            "UPDATE actions SET state='cancelled',version=version+1 WHERE tenant_id=$1 AND state IN('prepared','confirmed')",
            [job.old_tenant_id],
          );
          await client.query(
            "UPDATE action_items SET state='cancelled',version=version+1 WHERE tenant_id=$1 AND state IN('prepared','confirmed')",
            [job.old_tenant_id],
          );
          await client.query(
            "UPDATE subscription_delegations SET state='revoked',version=version+1 WHERE tenant_id=$1",
            [job.old_tenant_id],
          );
          await client.query(
            "UPDATE demo_fault_injections SET state='disabled',version=version+1 WHERE env_id=$1 AND generation=$2 AND state='armed'",
            [envId, job.old_generation],
          );
          await client.query(
            "UPDATE demo_environments SET lifecycle='resetting' WHERE id=$1",
            [envId],
          );
          await client.query(
            "UPDATE demo_reset_jobs SET phase='build_fixtures',version=version+1 WHERE id=$1",
            [job.id],
          );
        });
        const input: SeedEnvironmentInput = {
          tenantId: job.new_tenant_id,
          environmentId: envId,
          generation: job.new_generation,
          scenarioId: job.scenario_id,
          seedVersion: DEMO_SEED_VERSION,
        };
        await database.pool.query(
          "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state) VALUES($1,$2,$3,$4,'building','{}','building') ON CONFLICT(env_id,generation) DO UPDATE SET state='building'",
          [envId, job.new_generation, job.new_tenant_id, DEMO_SEED_VERSION],
        );
        const seed = await options.seedEnvironment(input);
        await database.pool.query(
          "UPDATE demo_reset_jobs SET phase='verify_fixtures' WHERE id=$1",
          [job.id],
        );
        await database.pool.query(
          "UPDATE demo_environments SET lifecycle='verifying' WHERE id=$1",
          [envId],
        );
        const manifest = await verify(input, seed);
        await tx(async (client) => {
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [lease.id, workerId, lease.lease_epoch],
          );
          if (!fence.rowCount)
            throw new AppError('INVALID_STATE', '重建任务租约已失效。');
          const env = await environment(client, true);
          if (
            env.active_generation !== job.old_generation ||
            env.active_tenant_id !== job.old_tenant_id
          )
            throw new AppError(
              'VERSION_CONFLICT',
              '环境已切换，拒绝陈旧重建任务。',
            );
          await client.query(
            "UPDATE demo_generation_manifests SET state='archived' WHERE env_id=$1 AND state='active'",
            [envId],
          );
          await client.query(
            "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state,verified_at) VALUES($1,$2,$3,$4,$5,$6,'active',now()) ON CONFLICT(env_id,generation) DO UPDATE SET seed_hash=$5,manifest=$6,state='active',verified_at=now()",
            [
              envId,
              job.new_generation,
              job.new_tenant_id,
              DEMO_SEED_VERSION,
              hash(manifest),
              JSON.stringify(manifest),
            ],
          );
          await client.query(
            "UPDATE demo_environments SET active_generation=$2,active_tenant_id=$3,lifecycle='ready',manifest_hash=$4,business_now='2026-11-05T03:00:00Z',clock_version=clock_version+1,version=version+1,updated_at=now() WHERE id=$1",
            [envId, job.new_generation, job.new_tenant_id, hash(manifest)],
          );
          await client.query(
            'UPDATE identity_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1',
            [job.old_tenant_id],
          );
          await client.query(
            "UPDATE demo_reset_jobs SET state='succeeded',phase='generation_activated',version=version+1,updated_at=now() WHERE id=$1",
            [job.id],
          );
          await audit(
            client,
            job.requested_by,
            'demo.reset_completed',
            job.old_generation,
            job.new_generation,
            job.id,
          );
        });
        await queue.finish(lease.id, workerId, lease.lease_epoch, 'succeeded');
        return true;
      } catch (error) {
        await tx(async (client) => {
          await client.query(
            "UPDATE demo_generation_manifests SET state='failed' WHERE env_id=$1 AND generation=$2 AND state='building'",
            [envId, job.new_generation],
          );
          await client.query(
            "UPDATE demo_reset_jobs SET state='failed',error_code=$2,version=version+1,updated_at=now() WHERE id=$1 AND state<>'succeeded'",
            [
              job.id,
              error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
            ],
          );
          await client.query(
            "UPDATE demo_environments SET lifecycle='failed',version=version+1 WHERE id=$1 AND active_generation=$2",
            [envId, job.old_generation],
          );
        });
        await queue
          .finish(
            lease.id,
            workerId,
            lease.lease_epoch,
            'failed',
            'RESET_FAILED',
          )
          .catch(() => {});
        return true;
      } finally {
        clearInterval(heartbeat);
      }
    },
    async businessClock() {
      enabled();
      const env = await environment();
      return {
        business_now: new Date(env.business_now).toISOString(),
        timezone: env.timezone,
        version: env.clock_version,
      };
    },
    async setBusinessClock(
      actor: ActorContext,
      input: {
        expected_generation: number;
        expected_environment_version: number;
        expected_version: number;
        business_now: string;
        timezone: string;
      },
      key: string,
    ) {
      actor = await actorCurrent(actor);
      if (!Number.isFinite(Date.parse(input.business_now)))
        throw new AppError('VALIDATION_ERROR', '业务时刻无效。');
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone });
      } catch {
        throw new AppError('VALIDATION_ERROR', '业务时区无效。');
      }
      return command(actor, 'demo.clock', key, input, async (client, env) => {
        guard(env, input);
        if (env.clock_version !== input.expected_version)
          throw new AppError('VERSION_CONFLICT', '业务时钟已更新。');
        const result = await client.query(
          'UPDATE demo_environments SET business_now=$2,timezone=$3,clock_version=clock_version+1,version=version+1 WHERE id=$1 RETURNING *',
          [envId, new Date(input.business_now), input.timezone],
        );
        await audit(
          client,
          actor.user_id,
          'demo.clock_changed',
          env.active_generation,
          env.active_generation,
        );
        return view(result.rows[0]);
      });
    },
    async armFault(actor: ActorContext, input: unknown, key: string) {
      actor = await actorCurrent(actor);
      const parsed = DemoFaultSchema.parse(input);
      if (!supportedFaults.has(parsed.kind))
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '该故障的消费者尚未接入，当前不能启用。',
          { details: { reason: 'FAULT_CONSUMER_NOT_CONNECTED' } },
        );
      return command(
        actor,
        'demo.fault.arm',
        key,
        parsed,
        async (client, env) => {
          guard(env, parsed);
          if (env.lifecycle !== 'ready')
            throw new AppError('INVALID_STATE', '维护期间不能注入故障。');
          const manifest = await client.query(
            'SELECT manifest FROM demo_generation_manifests WHERE env_id=$1 AND generation=$2',
            [envId, env.active_generation],
          );
          if (!manifest.rows[0]?.manifest?.alias_map?.[parsed.scope_alias])
            throw new AppError(
              'VALIDATION_ERROR',
              '故障范围必须来自当前演示清单。',
            );
          const result = await client.query(
            "INSERT INTO demo_fault_injections(id,env_id,generation,kind,scope_alias,remaining_hits,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 minute','armed') RETURNING *",
            [
              randomUUID(),
              envId,
              env.active_generation,
              parsed.kind,
              parsed.scope_alias,
              parsed.hits,
              parsed.ttl_minutes,
            ],
          );
          await audit(
            client,
            actor.user_id,
            'demo.fault_armed',
            env.active_generation,
            env.active_generation,
          );
          return result.rows[0];
        },
      );
    },
    async consumeFault(
      tenantId: string,
      kind: DemoFaultKind,
      scopeAlias: string,
    ) {
      enabled();
      const result = await database.pool.query(
        `WITH candidate AS(SELECT f.id FROM demo_fault_injections f JOIN demo_environments e ON e.id=f.env_id WHERE e.active_tenant_id=$1 AND e.lifecycle='ready' AND e.active_generation=f.generation AND f.kind=$2 AND f.scope_alias=$3 AND f.state='armed' AND f.expires_at>clock_timestamp() AND f.remaining_hits>0 ORDER BY f.created_at,f.id FOR UPDATE OF f SKIP LOCKED LIMIT 1) UPDATE demo_fault_injections f SET remaining_hits=f.remaining_hits-1,state=CASE WHEN f.remaining_hits=1 THEN 'exhausted' ELSE 'armed' END,version=f.version+1,updated_at=now() FROM candidate c WHERE f.id=c.id RETURNING f.id`,
        [tenantId, kind, scopeAlias],
      );
      return Boolean(result.rowCount);
    },
    async listFaults(actor: ActorContext) {
      await actorCurrent(actor);
      await database.pool.query(
        "UPDATE demo_fault_injections SET state='expired',version=version+1 WHERE env_id=$1 AND state='armed' AND expires_at<=clock_timestamp()",
        [envId],
      );
      const result = await database.pool.query(
        'SELECT * FROM demo_fault_injections WHERE env_id=$1 ORDER BY created_at DESC,id LIMIT 100',
        [envId],
      );
      return { items: result.rows };
    },
    async disableFault(
      actor: ActorContext,
      id: string,
      input: {
        expected_generation: number;
        expected_environment_version: number;
        expected_version: number;
      },
      key: string,
    ) {
      actor = await actorCurrent(actor);
      return command(
        actor,
        `demo.fault.disable:${id}`,
        key,
        input,
        async (client, env) => {
          guard(env, input);
          const result = await client.query(
            "UPDATE demo_fault_injections SET state='disabled',version=version+1,updated_at=now() WHERE env_id=$1 AND id=$2 AND generation=$3 AND version=$4 RETURNING *",
            [envId, id, env.active_generation, input.expected_version],
          );
          if (!result.rowCount)
            throw new AppError('VERSION_CONFLICT', '故障配置已更新。');
          return result.rows[0];
        },
      );
    },
    async triggerSummary(
      actor: ActorContext,
      input: {
        expected_generation: number;
        expected_environment_version: number;
        subscription_id?: string;
      },
      key: string,
    ) {
      actor = await actorCurrent(actor);
      return command(
        actor,
        'demo.summary.trigger',
        key,
        input,
        async (client, env) => {
          guard(env, input);
          if (!options.triggerSubscriptions)
            throw new AppError(
              'DEPENDENCY_UNAVAILABLE',
              '摘要调度服务尚未就绪。',
            );
          if (env.lifecycle !== 'ready')
            throw new AppError('INVALID_STATE', '演示环境尚未就绪。');
          if (input.subscription_id) {
            const subscription = await client.query(
              'SELECT 1 FROM subscriptions WHERE tenant_id=$1 AND id=$2',
              [env.active_tenant_id, input.subscription_id],
            );
            if (!subscription.rowCount)
              throw new AppError('NOT_FOUND', '当前环境中没有该日程。');
          }
          const requestId = randomUUID(),
            jobId = randomUUID();
          await client.query(
            `INSERT INTO demo_summary_triggers(id,env_id,tenant_id,generation,subscription_id,scheduled_for,requested_by,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              requestId,
              envId,
              env.active_tenant_id,
              env.active_generation,
              input.subscription_id ?? null,
              env.business_now,
              actor.user_id,
              jobId,
            ],
          );
          await client.query(
            `INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation) VALUES($1,$2,'demo','demo.summary',$3,$3,$4)`,
            [jobId, env.active_tenant_id, requestId, env.active_generation],
          );
          await audit(
            client,
            actor.user_id,
            'demo.summary.trigger',
            env.active_generation,
            env.active_generation,
            jobId,
          );
          return {
            request_id: requestId,
            job_id: jobId,
            status: 'queued' as const,
          };
        },
      );
    },
    async getSummaryTrigger(actor: ActorContext, id: string) {
      actor = await actorCurrent(actor);
      const env = await environment();
      const result = await database.pool.query(
        'SELECT id AS request_id,job_id,status,generation,subscription_id,scheduled_for,result,error_code,version,created_at,updated_at FROM demo_summary_triggers WHERE id=$1 AND env_id=$2 AND tenant_id=$3 AND generation=$4',
        [id, envId, actor.tenant_id, env.active_generation],
      );
      if (!result.rows[0])
        throw new AppError('NOT_FOUND', '摘要触发请求不存在。');
      return result.rows[0];
    },
    async processNextSummaryTrigger(workerId = 'demo-summary-worker') {
      enabled();
      const candidate = await database.pool.query(
        `SELECT r.id,r.tenant_id FROM demo_summary_triggers r JOIN durable_jobs j ON j.id=r.job_id JOIN demo_environments e ON e.id=r.env_id WHERE r.env_id=$1 AND r.status IN('queued','running') AND e.active_tenant_id=r.tenant_id AND e.active_generation=r.generation AND e.lifecycle='ready' AND j.ready_at<=now() AND (j.status='ready' OR (j.status='running' AND j.lease_until<now())) ORDER BY r.created_at,r.id LIMIT 1`,
        [envId],
      );
      if (!candidate.rows[0]) return false;
      const lease = await queue.claim(workerId, ['demo.summary'], 30000, {
        tenant_id: candidate.rows[0].tenant_id,
        payload_ref: candidate.rows[0].id,
      });
      if (!lease) return false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const request = await tx(async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
            ['demo-write:' + envId],
          );
          const env = await environment(client);
          const selected = await client.query(
            'SELECT * FROM demo_summary_triggers WHERE id=$1 AND env_id=$2 FOR UPDATE',
            [lease.payload_ref, envId],
          );
          const row = selected.rows[0];
          if (
            !row ||
            env.lifecycle !== 'ready' ||
            row.tenant_id !== env.active_tenant_id ||
            row.generation !== env.active_generation
          )
            throw new AppError('INVALID_STATE', '摘要请求所属环境已退役。');
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [lease.id, workerId, lease.lease_epoch],
          );
          if (!fence.rowCount)
            throw new AppError('INVALID_STATE', '摘要请求租约已失效。');
          await client.query(
            "UPDATE demo_summary_triggers SET status='running',version=version+1,updated_at=now() WHERE id=$1",
            [row.id],
          );
          return row;
        });
        heartbeat = setInterval(() => {
          void queue
            .heartbeat(lease.id, workerId, lease.lease_epoch)
            .catch(() => {});
        }, 10000);
        if (!options.triggerSubscriptions)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '摘要调度服务尚未就绪。',
          );
        const outcome = await options.triggerSubscriptions(
          request.tenant_id,
          new Date(request.scheduled_for),
          request.subscription_id ?? undefined,
        );
        await tx(async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
            ['demo-write:' + envId],
          );
          const env = await environment(client);
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [lease.id, workerId, lease.lease_epoch],
          );
          if (
            !fence.rowCount ||
            env.lifecycle !== 'ready' ||
            env.active_tenant_id !== request.tenant_id ||
            env.active_generation !== request.generation
          )
            throw new AppError('INVALID_STATE', '摘要请求租约或环境已失效。');
          const status = outcome.enqueued ? 'scheduled' : 'no_due_subscription';
          // 控制台只记录调度元数据，不保存个人摘要正文。
          await client.query(
            'UPDATE demo_summary_triggers SET status=$2,result=$3,error_code=NULL,version=version+1,updated_at=now() WHERE id=$1',
            [
              request.id,
              status,
              JSON.stringify({ enqueued: outcome.enqueued }),
            ],
          );
          await client.query(
            "UPDATE durable_jobs SET status='succeeded',lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1 AND lease_epoch=$2",
            [lease.id, lease.lease_epoch],
          );
        });
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
        await tx(async (client) => {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            ['demo-write:' + envId],
          );
          const env = await environment(client);
          const current = await client.query(
            'SELECT tenant_id,generation FROM demo_summary_triggers WHERE id=$1 AND env_id=$2 FOR UPDATE',
            [lease.payload_ref, envId],
          );
          const row = current.rows[0];
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [lease.id, workerId, lease.lease_epoch],
          );
          if (!row || !fence.rowCount) return;
          const retired =
            env.lifecycle !== 'ready' ||
            row.tenant_id !== env.active_tenant_id ||
            row.generation !== env.active_generation;
          await client.query(
            'UPDATE demo_summary_triggers SET status=$2,error_code=$3,version=version+1,updated_at=now() WHERE id=$1',
            [lease.payload_ref, retired ? 'cancelled' : 'failed', code],
          );
          await client.query(
            "SELECT set_config('caixiaozhi.demo_control','on',true)",
          );
          await client.query(
            'UPDATE durable_jobs SET status=$2,error_code=$3,lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=now() WHERE id=$1',
            [lease.id, retired ? 'cancelled' : 'failed', code],
          );
        });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      return true;
    },
    async listScenarios() {
      enabled();
      return {
        items: scenarios.map((scenario) => ({
          ...scenario,
          requires_reset: true,
        })),
      };
    },
    async startScenario(
      actor: ActorContext,
      id: string,
      input: {
        expected_generation: number;
        expected_environment_version: number;
      },
      key: string,
    ) {
      actor = await actorCurrent(actor);
      const scenario = DemoScenarioSchema.parse(id);
      return command(
        actor,
        `demo.scenario:${id}`,
        key,
        input,
        async (client, env) => {
          guard(env, input);
          const result = await client.query(
            "INSERT INTO demo_scenario_runs(id,env_id,generation,scenario_id,state,requested_by) VALUES($1,$2,$3,$4,'queued',$5) RETURNING *",
            [
              randomUUID(),
              envId,
              env.active_generation,
              scenario,
              actor.user_id,
            ],
          );
          return result.rows[0];
        },
      );
    },
    async recordEvidence(
      id: string,
      input: {
        step_id: string;
        passed: boolean;
        resource_refs: Array<{ type: string; id: string; version: number }>;
        trace_id: string;
      },
    ) {
      enabled();
      const result = await database.pool.query(
        "UPDATE demo_scenario_runs SET evidence=evidence||$3::jsonb,state=CASE WHEN $4 THEN 'running' ELSE 'failed' END,version=version+1,updated_at=now() WHERE id=$1 AND env_id=$2 AND state IN('queued','running') RETURNING id,state",
        [id, envId, JSON.stringify([input]), input.passed],
      );
      if (!result.rowCount)
        throw new AppError('INVALID_STATE', '场景记录当前不可追加证据。');
      return result.rows[0];
    },
  };
  return service;
}
export type DemoService = ReturnType<typeof createDemoService>;
