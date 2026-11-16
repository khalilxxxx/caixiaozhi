import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { loadConfig } from '@caixiaozhi/platform/config';
import { AppError } from '@caixiaozhi/platform/errors';
import { IdentityService } from '../../packages/identity/src/service.js';
import { seedBusiness } from '../../packages/fixtures/src/business.js';
import { createDemoService } from '../../packages/demo/src/service.js';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createMemoryService } from '../../packages/assistant/src/memory.js';
import { createApplicationFaults } from '../../packages/application/src/faults.js';
import type { ActionHandler } from '@caixiaozhi/business-adapters/ports';
import { sql } from 'drizzle-orm';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
const suffix = randomUUID();
const environmentId = `demo-test-${suffix}`,
  logicalTenant = `demo-root-${suffix}`;
const tenants: string[] = [];
let failSeed = false;
const identity = new IdentityService(database, {
  appMode: 'demo',
  demoAccessEnabled: true,
  sessionSecret: 'fixture-test-secret-'.repeat(3),
});
const actor = (tenant = logicalTenant): ActorContext => ({
  tenant_id: tenant,
  user_id: 'u-zhao',
  roles: ['platform_admin'],
  department_ids: ['dept-it'],
  permissions: ['demo.control', 'operations.read'],
  authz_version: 1,
  session_id: 'control-test-session',
  invocation_origin: 'interactive',
  delegation_id: null,
});
const demo = createDemoService(database, {
  appMode: 'test',
  environmentId,
  logicalTenantId: logicalTenant,
  freshActor: async (value) => value,
  triggerSubscriptions: (tenantId, at, subscriptionId) =>
    memory.scheduleDueSubscriptions(at, 30, { tenantId, subscriptionId }),
  seedEnvironment: async (input) => {
    tenants.push(input.tenantId);
    if (failSeed) throw new Error('explicit-test-seed-failure');
    await identity.seedDemoIdentity({
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      generation: input.generation,
    });
    return seedBusiness({ database, storage, tenantId: input.tenantId });
  },
});
const memory = createMemoryService(database, {
  freshActor: async (value) => value,
  createDelegation: async () => ({ id: randomUUID(), version: 1 }),
  resolveDelegation: async (tenantId, id) => ({
    ...actor(tenantId),
    session_id: null,
    invocation_origin: 'subscription',
    delegation_id: id,
  }),
});
demo.registerFaultConsumer('ocr.timeout');
const resetInput = (env: { generation: number; version: number }) => ({
  seed_version: 'finance-agent-v1.0',
  expected_generation: env.generation,
  expected_environment_version: env.version,
  scenario_id: 'baseline',
  intent: 'reset_demo_environment',
});
beforeAll(async () => {
  await demo.initialize();
}, 30000);
afterAll(async () => {
  const ids = [...new Set(tenants)];
  const files = await database.pool.query(
    'SELECT object_key FROM uploaded_files WHERE tenant_id=ANY($1::text[])',
    [ids],
  );
  for (const file of files.rows)
    await storage.deleteObject(file.object_key).catch(() => {});
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('caixiaozhi.demo_control','on',true)",
    );
    for (const table of [
      'demo_control_commands',
      'demo_fault_injections',
      'demo_control_audit',
      'demo_scenario_runs',
      'demo_summary_triggers',
      'demo_reset_jobs',
      'demo_generation_manifests',
    ])
      await client.query(`DELETE FROM ${table} WHERE env_id=$1`, [
        environmentId,
      ]);
    await client.query('DELETE FROM demo_environments WHERE id=$1', [
      environmentId,
    ]);
    await client.query(
      'UPDATE threads SET active_run_id=NULL WHERE tenant_id=ANY($1::text[])',
      [ids],
    );
    const tables = (
      await client.query(
        "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'",
      )
    ).rows.map((r) => r.table_name as string);
    let pending = tables;
    for (let round = 0; round < 20 && pending.length; round++) {
      const next = [];
      for (const table of pending) {
        await client.query('SAVEPOINT cleanup_table');
        try {
          await client.query(
            `DELETE FROM "${table}" WHERE tenant_id=ANY($1::text[])`,
            [ids],
          );
          await client.query('RELEASE SAVEPOINT cleanup_table');
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT cleanup_table');
          next.push(table);
        }
      }
      pending = next;
    }
    await client.query('COMMIT');
  } finally {
    client.release();
    storage.close();
    await database.close();
  }
}, 30000);
describe('真实数据库Demo控制与generation最终写屏障', () => {
  it('摘要触发先持久化再在控制锁外调度，同键复用且限定当前环境日程', async () => {
    let env = await demo.current();
    const owner = {
      ...actor(),
      permissions: [
        'expense.read.department',
        'analytics.query',
      ] as ActorContext['permissions'],
    };
    const subscription = await memory.createSubscription(
      owner,
      {
        type: 'todo_digest',
        title: '摘要队列回归',
        schedule: {
          frequency: 'daily',
          local_time: '09:00',
          timezone: 'Asia/Shanghai',
          start_date: '2026-11-05',
        },
        query_spec: {
          scope: 'current_approval_scope',
          include_existing_preaudit: true,
        },
        skill_version_id: null,
        delivery: { channel: 'in_app' },
      },
      randomUUID(),
    );
    await database.pool.query(
      "UPDATE subscriptions SET next_run_at='2026-11-05T01:00:00Z' WHERE id=$1",
      [subscription.subscription.id],
    );
    const key = randomUUID(),
      input = {
        expected_generation: env.generation,
        expected_environment_version: env.version,
        subscription_id: subscription.subscription.id,
      };
    const queued = await demo.triggerSummary(actor(), input, key);
    expect(queued.status).toBe('queued');
    expect(await demo.triggerSummary(actor(), input, key)).toEqual(queued);
    expect(
      (await memory.occurrences(owner, subscription.subscription.id)).items,
    ).toHaveLength(0);
    await demo.processNextSummaryTrigger('summary-trigger-regression');
    expect(
      await demo.getSummaryTrigger(actor(), queued.request_id),
    ).toMatchObject({ status: 'scheduled', result: { enqueued: 1 } });
    expect(
      (await memory.occurrences(owner, subscription.subscription.id)).items,
    ).toHaveLength(1);
    env = await demo.current();
    const second = await demo.triggerSummary(
      actor(),
      { ...input, expected_environment_version: env.version },
      randomUUID(),
    );
    await demo.processNextSummaryTrigger('summary-trigger-regression');
    expect(
      await demo.getSummaryTrigger(actor(), second.request_id),
    ).toMatchObject({ status: 'no_due_subscription', result: { enqueued: 0 } });
    await memory.changeSubscription(
      owner,
      subscription.subscription.id,
      'pause',
      subscription.subscription.version,
      randomUUID(),
    );
  });
  it('seed二次幂等且真实验证七人十一单、金额和clm004未知事实', async () => {
    const a = await demo.current();
    const b = await demo.initialize();
    expect(a.manifest_hash).toBe(b.manifest_hash);
    expect(a.lifecycle).toBe('ready');
    const manifest = await demo.manifest(actor());
    expect(manifest.manifest.expected_counts).toEqual({ users: 7, claims: 11 });
    expect(manifest.manifest.assertions.every((item: any) => item.passed)).toBe(
      true,
    );
  });
  it('业务时钟回拨不改变真实fault TTL，范围与命中次数隔离', async () => {
    let env = await demo.current();
    const fault = await demo.armFault(
      actor(),
      {
        expected_generation: env.generation,
        expected_environment_version: env.version,
        kind: 'ocr.timeout',
        scope_alias: 'clm-001',
        hits: 1,
        ttl_minutes: 5,
      },
      randomUUID(),
    );
    const ttl = new Date(fault.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(240000);
    env = await demo.setBusinessClock(
      actor(),
      {
        expected_generation: env.generation,
        expected_environment_version: env.version,
        expected_version: env.clock_version,
        business_now: '2026-10-01T01:00:00Z',
        timezone: 'Asia/Shanghai',
      },
      randomUUID(),
    );
    expect(
      await demo.consumeFault('other-tenant', 'ocr.timeout', 'clm-001'),
    ).toBe(false);
    expect(
      await demo.consumeFault(env.active_tenant_id, 'ocr.timeout', 'clm-001'),
    ).toBe(true);
    expect(
      await demo.consumeFault(env.active_tenant_id, 'ocr.timeout', 'clm-001'),
    ).toBe(false);
    expect(new Date(fault.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
  it('未接消费者的故障arm明确拒绝，不能假装已生效', async () => {
    const env = await demo.current();
    await expect(
      demo.armFault(
        actor(),
        {
          expected_generation: env.generation,
          expected_environment_version: env.version,
          kind: 'maas.read_unavailable',
          scope_alias: 'clm-001',
          hits: 1,
          ttl_minutes: 5,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      details: { reason: 'FAULT_CONSUMER_NOT_CONNECTED' },
    });
  });
  it('本控制器不会领取或失败掉其他环境的reset作业', async () => {
    const foreignTenant = `foreign-${suffix}`,
      payload = randomUUID(),
      id = randomUUID();
    await database.pool.query(
      "INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key) VALUES($1,$2,'demo','demo.reset',$3,$3)",
      [id, foreignTenant, payload],
    );
    try {
      expect(await demo.runNextReset('foreign-isolation-test')).toBe(false);
      expect(
        (
          await database.pool.query(
            'SELECT status FROM durable_jobs WHERE id=$1',
            [id],
          )
        ).rows[0].status,
      ).toBe('ready');
    } finally {
      await database.pool.query('DELETE FROM durable_jobs WHERE id=$1', [id]);
    }
  });
  it('消费者按alias真实消费，回包丢失发生在领域事务提交之后', async () => {
    const faults = createApplicationFaults(database, demo, {
      enabledKinds: [
        'ocr.timeout',
        'preaudit.check_unavailable',
        'action.response_lost_after_commit',
      ],
    });
    const env = await demo.current();
    const guard = {
      expected_generation: env.generation,
      expected_environment_version: env.version,
    };
    await demo.armFault(
      actor(),
      {
        ...guard,
        kind: 'ocr.timeout',
        scope_alias: 'clm-003',
        hits: 1,
        ttl_minutes: 5,
      },
      randomUUID(),
    );
    await expect(
      faults.beforeOcr({ tenant_id: logicalTenant, resource_ids: ['clm-003'] }),
    ).rejects.toMatchObject({ details: { reason: 'DEMO_OCR_TIMEOUT' } });
    await expect(
      faults.beforeOcr({ tenant_id: logicalTenant, resource_ids: ['clm-003'] }),
    ).resolves.toBeUndefined();
    await demo.armFault(
      actor(),
      {
        ...guard,
        kind: 'action.response_lost_after_commit',
        scope_alias: 'clm-001',
        hits: 1,
        ttl_minutes: 5,
      },
      randomUUID(),
    );
    let commits = 0;
    const receiptId = randomUUID();
    const receipt = () => ({
      id: receiptId,
      action_id: 'explicit-test-action',
      idempotency_key: 'explicit-test-key',
      outcome: 'succeeded' as const,
      resource: { type: 'expense_claim' as const, id: 'clm-001', version: 2 },
      external_receipt_id: null,
      occurred_at: new Date().toISOString(),
      data_mode: 'demo' as const,
      error_code: null,
    });
    const handler: ActionHandler<{ title: string }> = {
      validate: async () => ({ summary: {} }),
      execute: async (_ctx, tx, action) => {
        if (!tx) throw new Error('transaction required');
        await tx.execute(
          sql`UPDATE expense_claims SET title=${action.args.title},version=version+1 WHERE tenant_id=${logicalTenant} AND id='clm-001'`,
        );
        commits++;
        return receipt();
      },
      queryOutcome: async () => {
        const row = await database.pool.query(
          "SELECT title FROM expense_claims WHERE tenant_id=$1 AND id='clm-001'",
          [logicalTenant],
        );
        expect(row.rows[0].title).toBe('已提交的显式测试改动');
        return receipt();
      },
    };
    const wrapped = faults.wrapCommittedResponseLoss(handler);
    const ctx = {
      actor: actor(),
      action_id: 'explicit-test-action',
      item_id: 'explicit-test-item',
      idempotency_key: 'explicit-test-key',
      external_request_id: 'explicit-test-remote',
      run_id: null,
      trace_id: null,
      generation: 1,
    };
    const action = {
      id: ctx.action_id,
      operation: 'approval.approve' as const,
      args: { title: '已提交的显式测试改动' },
      resource_refs: [
        { type: 'expense_claim' as const, id: 'clm-001', version: 1 },
      ],
      item: {
        id: ctx.item_id,
        ordinal: 0,
        resource_ref: {
          type: 'expense_claim' as const,
          id: 'clm-001',
          version: 1,
        },
        args: { title: '已提交的显式测试改动' },
      },
      confirmation: {
        id: 'explicit-test-confirmation',
        args_hash: 'hash',
        summary_hash: 'hash',
        dependency_refs: [],
        extra_guards: {},
      },
    };
    await expect(wrapped.execute(ctx, null, action)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
    expect(commits).toBe(1);
    expect((await wrapped.queryOutcome(ctx, action)).outcome).toBe('succeeded');
    expect(commits).toBe(1);
    const rejected = faults.wrapCommittedResponseLoss({
      ...handler,
      execute: async (_ctx, tx) => {
        if (!tx) throw new Error('transaction required');
        await tx.execute(
          sql`UPDATE expense_claims SET title='不会提交的改动' WHERE tenant_id=${logicalTenant} AND id='clm-001'`,
        );
        throw new AppError('VERSION_CONFLICT', '执行前已知版本冲突。');
      },
    });
    await expect(rejected.execute(ctx, null, action)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { effect_not_started: true },
    });
    expect(
      (
        await database.pool.query(
          "SELECT title FROM expense_claims WHERE tenant_id=$1 AND id='clm-001'",
          [logicalTenant],
        )
      ).rows[0].title,
    ).toBe('已提交的显式测试改动');
  });
  it('reset幂等、真实DB触发器阻止陈旧pg写入，旧租约失效，新代完整后才切入口', async () => {
    const env = await demo.current();
    const runs = createRunService(database, {
      freshActor: async (value) => value,
    });
    const run = await runs.createRun(
      actor(),
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    const lease = await runs.claimRun('old-generation-worker');
    expect(lease?.run.id).toBe(run.id);
    const input = resetInput(env),
      key = randomUUID();
    const job = await demo.requestReset(actor(), input, key);
    expect((await demo.requestReset(actor(), input, key)).id).toBe(job.id);
    await expect(
      demo.requestReset(actor(), { ...input, scenario_id: 'E2E-01' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      database.pool.query(
        "UPDATE expense_claims SET title='stale-worker' WHERE tenant_id=$1 AND id='clm-001'",
        [logicalTenant],
      ),
    ).rejects.toThrow('DEMO_GENERATION_FENCED');
    expect((await demo.current()).active_tenant_id).toBe(logicalTenant);
    await demo.runNextReset('reset-test-worker');
    const next = await demo.current();
    expect(next.generation).toBe(2);
    expect(next.active_tenant_id).not.toBe(logicalTenant);
    expect(next.lifecycle).toBe('ready');
    await expect(demo.gate.assertCurrentActor(actor())).rejects.toMatchObject({
      details: { reason: 'DEMO_GENERATION_CHANGED' },
    });
    await expect(
      runs.assertLease(run.id, lease!.lease_epoch),
    ).rejects.toThrow();
    const old = await database.pool.query(
      "SELECT title FROM expense_claims WHERE tenant_id=$1 AND id='clm-001'",
      [logicalTenant],
    );
    expect(old.rows[0].title).not.toBe('stale-worker');
  });
  it('unknown写入阻塞reset并保留账本，核实后继续同一任务', async () => {
    let env = await demo.current();
    const activeActor = actor(env.active_tenant_id);
    const actionId = randomUUID(),
      confirmationId = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(
        "INSERT INTO confirmations(id,tenant_id,actor_id,session_id,authz_version,action_id,operation,args_hash,summary_hash,resource_refs,summary,expires_at) VALUES($1,$2,'u-zhao','fixture',1,$3,'approval.approve','hash','hash','[]','{}',now()+interval '10 minutes')",
        [confirmationId, env.active_tenant_id, actionId],
      );
      await client.query(
        "INSERT INTO actions(id,tenant_id,actor_id,actor_context,confirmation_id,operation,state,idempotency_key,payload_hash,args,resource_refs,prepared_domain) VALUES($1,$2,'u-zhao',$3,$4,'approval.approve','unknown',$5,'hash','{}','[]','{}')",
        [
          actionId,
          env.active_tenant_id,
          JSON.stringify(activeActor),
          confirmationId,
          randomUUID(),
        ],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const job = await demo.requestReset(
      activeActor,
      resetInput(env),
      randomUUID(),
    );
    await demo.runNextReset('reset-test-worker');
    expect((await demo.getResetJob(activeActor, job.id)).state).toBe('blocked');
    expect((await demo.current()).active_tenant_id).toBe(env.active_tenant_id);
    expect(
      (
        await database.pool.query('SELECT state FROM actions WHERE id=$1', [
          actionId,
        ])
      ).rows[0].state,
    ).toBe('unknown');
    await database.pool.query(
      "UPDATE actions SET state='failed',version=version+1 WHERE id=$1",
      [actionId],
    );
    env = await demo.current();
    await demo.resumeReset(
      activeActor,
      job.id,
      {
        expected_generation: env.generation,
        expected_environment_version: env.version,
      },
      randomUUID(),
    );
    await demo.runNextReset('reset-test-worker');
    expect((await demo.current()).generation).toBe(3);
    expect(
      (
        await database.pool.query('SELECT state FROM actions WHERE id=$1', [
          actionId,
        ])
      ).rows[0].state,
    ).toBe('failed');
  });
  it('构建失败不激活半套数据，production服务与CLI入口拒绝控制', async () => {
    const env = await demo.current();
    const controlSession = await identity.loginDemo('u-zhao', undefined, {
      tenantId: env.active_tenant_id,
      environmentId,
      generation: env.generation,
    });
    failSeed = true;
    const failedJob = await demo.requestReset(
      actor(env.active_tenant_id),
      resetInput(env),
      randomUUID(),
    );
    await demo.runNextReset('reset-test-worker');
    const failed = await demo.current();
    expect(failed.generation).toBe(env.generation);
    expect(failed.active_tenant_id).toBe(env.active_tenant_id);
    expect(failed.lifecycle).toBe('failed');
    await expect(
      identity.getActor(controlSession.session_token),
    ).resolves.toMatchObject({
      tenant_id: env.active_tenant_id,
      user_id: 'u-zhao',
    });
    failSeed = false;
    const retry = await demo.requestReset(
      actor(env.active_tenant_id),
      resetInput(failed),
      randomUUID(),
    );
    expect(retry.new_generation).toBeGreaterThan(failedJob.new_generation);
    await demo.runNextReset('reset-test-worker');
    expect((await demo.current()).generation).toBe(retry.new_generation);
    expect(
      (
        await database.pool.query(
          'SELECT namespace_ref,state FROM demo_generation_manifests WHERE env_id=$1 AND generation=$2',
          [environmentId, failedJob.new_generation],
        )
      ).rows[0],
    ).toEqual({ namespace_ref: failedJob.new_tenant_id, state: 'failed' });
    await expect(
      database.pool.query(
        'INSERT INTO identity_environments(tenant_id,id,generation) VALUES($1,$2,$3)',
        [failedJob.new_tenant_id, environmentId, failedJob.new_generation],
      ),
    ).rejects.toThrow('DEMO_GENERATION_FENCED');
    await expect(
      identity.getActor(controlSession.session_token),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const production = createDemoService(database, {
      appMode: 'production',
      seedEnvironment: async () => {
        throw new Error('must not run');
      },
    });
    await expect(production.initialize()).rejects.toMatchObject({
      details: { reason: 'DEMO_DISABLED' },
    });
    await expect(
      production.consumeFault(env.active_tenant_id, 'ocr.timeout', 'clm-001'),
    ).rejects.toThrow('生产环境');
  });
});
