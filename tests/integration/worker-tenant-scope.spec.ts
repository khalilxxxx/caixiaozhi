import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import type { AgentRuntimeAdapter } from '../../packages/agent-runtime/src/adapter.js';
import { createWorkerRunner } from '../../apps/worker/src/runner/index.js';
import { createMemoryService } from '../../packages/assistant/src/memory.js';
import { createDurableQueue } from '../../packages/jobs/src/queue.js';
import { createFinanceService } from '../../packages/finance/src/index.js';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { DocumentService } from '../../packages/business-adapters/src/domain/documents.js';
import {
  getApprovalTask,
  getPreauditInput,
  listCurrentApprovalDocuments,
} from '../../packages/business-adapters/src/domain/projection.js';

const database = createDatabase(loadConfig().databaseUrl),
  tenants: string[] = [],
  environments: string[] = [];
const actor = (tenant_id: string): ActorContext => ({
  tenant_id,
  user_id: 'explicit-scope-owner',
  roles: ['manager'],
  department_ids: ['sales'],
  permissions: ['expense.read.department', 'analytics.query'],
  authz_version: 1,
  session_id: 'explicit-test-session',
  invocation_origin: 'interactive',
  delegation_id: null,
});
const tenantPair = () => {
  const local = `scope-local-${randomUUID()}`,
    foreign = `scope-foreign-${randomUUID()}`;
  tenants.push(local, foreign);
  return { local, foreign };
};
async function archive(tenant: string) {
  const env = `scope-env-${randomUUID()}`;
  environments.push(env);
  await database.pool.query(
    "INSERT INTO demo_environments(id,logical_tenant_id,active_tenant_id,active_generation,lifecycle,seed_version) VALUES($1,$2,$3,2,'ready','finance-agent-v1.0')",
    [env, `${tenant}-logical`, `${tenant}-current`],
  );
  await database.pool.query(
    "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state) VALUES($1,1,$2,'finance-agent-v1.0','explicit-scope-fixture','{}','archived')",
    [env, tenant],
  );
}
afterAll(async () => {
  // 先撤除测试归档登记，再按外键次序清理，避免让DB最终写屏障掩盖清理错误。
  await database.pool.query(
    'DELETE FROM demo_generation_manifests WHERE env_id=ANY($1::text[])',
    [environments],
  );
  await database.pool.query(
    'DELETE FROM demo_environments WHERE id=ANY($1::text[])',
    [environments],
  );
  for (const table of [
    'inbox_reads',
    'inbox_items',
    'digest_snapshots',
    'subscription_occurrences',
    'subscriptions',
    'assistant_commands',
    'model_slots',
    'agent_runs',
    'runtime_fairness',
    'durable_jobs',
    'outbox_events',
    'identity_environments',
  ])
    await database.pool.query(
      `DELETE FROM ${table} WHERE tenant_id=ANY($1::text[])`,
      [tenants],
    );
  await database.close();
});
describe('Demo Worker真实SQL租户范围隔离', () => {
  it('run领取和恢复、财务作业与通用队列跳过其他环境及归档tenant', async () => {
    const { local, foreign } = tenantPair(),
      scope = { tenant_id: local };
    const runs = createRunService(database, {
      freshActor: async (value) => value,
    });
    const create = (tenantId: string) =>
      runs.createRun(
        actor(tenantId),
        { thread_id: randomUUID(), input_message_id: randomUUID() },
        randomUUID(),
      );
    const foreignRun = await create(foreign),
      localRun = await create(local);
    const first = await runs.claimRun('scope-direct-worker', scope);
    expect(first?.run.id).toBe(localRun.id);
    await runs.finishRun(localRun.id, first!.lease_epoch, 'succeeded');
    const foreignLease = await runs.claimRun('foreign-expired-fixture', {
      tenant_id: foreign,
    });
    expect(foreignLease?.run.id).toBe(foreignRun.id);
    await database.pool.query(
      "UPDATE run_leases SET lease_until=now()-interval '1 second' WHERE run_id=$1",
      [foreignRun.id],
    );
    const pending = await create(local),
      queue = createDurableQueue(database);
    await database.pool.query(
      'INSERT INTO identity_environments(tenant_id,id,generation) VALUES($1,$1,1),($2,$2,1)',
      [local, foreign],
    );
    const enqueue = (tenant_id: string, kind: string) =>
      queue.enqueue({
        tenant_id,
        owner_module: 'explicit-scope-fixture',
        kind,
        payload_ref: randomUUID(),
        dedupe_key: randomUUID(),
        ready_at: new Date(0),
        generation: 1,
      });
    const foreignFinance = await enqueue(foreign, 'rules.test'),
      localFinance = await enqueue(local, 'rules.test');
    const foreignGeneric = await enqueue(foreign, 'expense.ocr'),
      localGeneric = await enqueue(local, 'expense.ocr');
    await archive(foreign);
    const starts: string[] = [];
    const start: AgentRuntimeAdapter['start'] = async (input) => {
      starts.push(input.run_id);
      return {
        runtime_instance_id: 'explicit-scope-test-adapter',
        runtime_session_id: 'explicit-scope-test-session',
        events: (async function* () {
          yield { type: 'idle' as const };
        })(),
      };
    };
    const runtime: AgentRuntimeAdapter = {
      start,
      continue: start,
      dispose: async () => {},
      stop: async () => ({
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'flushed',
      }),
    };
    let scopeReads = 0;
    const runner = createWorkerRunner({
      runs,
      runtime,
      freshActor: async (value) => value,
      claimScope: async () => {
        scopeReads++;
        return scope;
      },
    });
    await runner.tick();
    await runner.waitForIdle();
    await runner.tick();
    await runner.waitForIdle();
    expect(scopeReads).toBe(2);
    expect(starts).toEqual([pending.id]);
    expect((await runs.getRun(actor(local), pending.id)).status).toBe(
      'succeeded',
    );
    expect(await runs.getRun(actor(foreign), foreignRun.id)).toMatchObject({
      status: 'running',
      runtime_active: true,
    });
    expect(
      (
        await database.pool.query(
          'SELECT recovery_count FROM agent_runs WHERE id=$1',
          [foreignRun.id],
        )
      ).rows[0].recovery_count,
    ).toBe(0);
    const identity = createIdentityService(database, {
      sessionSecret: 'scope-fixture-secret-at-least-32-characters',
      appMode: 'demo',
      demoAccessEnabled: true,
    });
    const documents = new DocumentService(database, { identity });
    const finance = createFinanceService(database, {
      identity,
      jobs: queue,
      business: {
        getPreauditInput: (ctx, id, version, tx) =>
          getPreauditInput(documents, ctx, id, version, tx),
        getApprovalTask: (ctx, ref, tx) =>
          getApprovalTask(documents, ctx, ref, tx),
        listCurrentApprovalDocuments: (ctx) =>
          listCurrentApprovalDocuments(documents, ctx),
      },
    });
    // 明确的缺失领域对象夹具：本租户作业真实领取后以NOT_FOUND失败，外租户不得被领取或改账。
    await expect(
      finance.processNextJob('scope-finance-worker', scope),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await finance.processNextJob('scope-finance-worker', scope)).toBe(
      false,
    );
    expect(
      (
        await database.pool.query(
          'SELECT status,error_code FROM durable_jobs WHERE id=$1',
          [localFinance.id],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', error_code: 'NOT_FOUND' });
    const generic = await queue.claim(
      'scope-generic-worker',
      ['expense.ocr'],
      undefined,
      scope,
    );
    expect(generic?.id).toBe(localGeneric.id);
    await queue.finish(
      generic!.id,
      'scope-generic-worker',
      generic!.lease_epoch,
      'succeeded',
    );
    expect(
      await queue.claim(
        'scope-generic-worker',
        ['expense.ocr'],
        undefined,
        scope,
      ),
    ).toBeNull();
    expect(
      (
        await database.pool.query(
          'SELECT status,attempt FROM durable_jobs WHERE id=ANY($1::text[]) ORDER BY id',
          [[foreignFinance.id, foreignGeneric.id]],
        )
      ).rows,
    ).toEqual([
      { status: 'ready', attempt: 0 },
      { status: 'ready', attempt: 0 },
    ]);
    await runner.stop();
  });
  it('摘要生成与限量投递在SQL选取前限定tenant，归档摘要和作业保持未领取', async () => {
    const { local, foreign } = tenantPair(),
      clock = new Date('2026-11-05T00:00:00Z'),
      reads: string[] = [];
    const memory = createMemoryService(database, {
      freshActor: async (value) => value,
      clock: () => clock,
      createDelegation: async () => ({ id: randomUUID(), version: 1 }),
      resolveDelegation: async (tenantId, id) => ({
        ...actor(tenantId),
        session_id: null,
        invocation_origin: 'subscription',
        delegation_id: id,
      }),
      readDigest: async (value) => {
        reads.push(value.tenant_id);
        return {
          title: '明确租户隔离测试摘要',
          preview: value.tenant_id,
          content: '此结果只送达其所属租户。',
          source_refs: [],
          coverage: 'complete',
          generated_at: clock.toISOString(),
        };
      },
    });
    const input = {
      type: 'todo_digest',
      title: '隔离日程',
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
    };
    const a = await memory.createSubscription(
        actor(foreign),
        input,
        randomUUID(),
      ),
      b = await memory.createSubscription(actor(local), input, randomUUID());
    clock.setUTCHours(1);
    await memory.scheduleDueSubscriptions(clock, 30, {
      tenantId: foreign,
      subscriptionId: a.subscription.id,
    });
    await memory.scheduleDueSubscriptions(clock, 30, {
      tenantId: local,
      subscriptionId: b.subscription.id,
    });
    await memory.generateNextDigest('foreign-outbox-fixture', {
      tenant_id: foreign,
    });
    // 保留外租户未投递旧快照，再建立一条更早ready_at的外租户待生成作业。
    await memory.scheduleDueSubscriptions(
      new Date('2026-11-06T01:00:00Z'),
      30,
      { tenantId: foreign, subscriptionId: a.subscription.id },
    );
    await database.pool.query(
      "UPDATE durable_jobs SET ready_at='2000-01-01' WHERE tenant_id=$1 AND kind='digest.generate' AND status='ready'",
      [foreign],
    );
    await database.pool.query(
      "UPDATE outbox_events SET created_at='2000-01-01' WHERE tenant_id=$1 AND event_type='digest.generated'",
      [foreign],
    );
    await archive(foreign);
    expect(
      await memory.scheduleDueSubscriptions(
        new Date('2026-11-09T01:00:00Z'),
        30,
        { tenantId: foreign, subscriptionId: a.subscription.id },
      ),
    ).toEqual({ scanned: 0, enqueued: 0 });
    expect(
      await memory.generateNextDigest('archived-digest-worker', {
        tenant_id: foreign,
      }),
    ).toBe(false);
    expect(await memory.deliverPending(1, { tenant_id: foreign })).toEqual({
      delivered: 0,
    });
    const archivedEvent = (
      await database.pool.query(
        "SELECT id FROM outbox_events WHERE tenant_id=$1 AND event_type='digest.generated' ORDER BY id LIMIT 1",
        [foreign],
      )
    ).rows[0];
    await expect(memory.deliverInbox(archivedEvent.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const maintenanceEnvironment = `scope-maintenance-${randomUUID()}`;
    environments.push(maintenanceEnvironment);
    await database.pool.query(
      "INSERT INTO demo_environments(id,logical_tenant_id,active_tenant_id,active_generation,lifecycle,seed_version) VALUES($1,$2,$3,1,'draining','finance-agent-v1.0')",
      [maintenanceEnvironment, `${local}-logical`, local],
    );
    expect(
      await memory.scheduleDueSubscriptions(
        new Date('2026-11-09T01:00:00Z'),
        30,
        { tenantId: local, subscriptionId: b.subscription.id },
      ),
    ).toEqual({ scanned: 0, enqueued: 0 });
    expect(
      await memory.generateNextDigest('maintenance-digest-worker', {
        tenant_id: local,
      }),
    ).toBe(false);
    await database.pool.query(
      "UPDATE demo_environments SET lifecycle='ready' WHERE id=$1",
      [maintenanceEnvironment],
    );
    expect(
      await memory.generateNextDigest('local-digest-worker', {
        tenant_id: local,
      }),
    ).toBe(true);
    expect(
      await memory.generateNextDigest('local-digest-worker', {
        tenant_id: local,
      }),
    ).toBe(false);
    expect(reads).toEqual([foreign, local]);
    expect(
      (
        await database.pool.query(
          "SELECT status,attempt FROM durable_jobs WHERE tenant_id=$1 AND kind='digest.generate' AND status='ready'",
          [foreign],
        )
      ).rows,
    ).toEqual([{ status: 'ready', attempt: 0 }]);
    expect(await memory.deliverPending(1, { tenant_id: local })).toEqual({
      delivered: 1,
    });
    expect(await memory.deliverPending(1, { tenant_id: local })).toEqual({
      delivered: 0,
    });
    expect((await memory.listInbox(actor(local))).items).toHaveLength(1);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM inbox_items WHERE tenant_id=$1',
          [foreign],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await database.pool.query(
          "SELECT published_at FROM outbox_events WHERE tenant_id=$1 AND event_type='digest.generated'",
          [foreign],
        )
      ).rows,
    ).toEqual([{ published_at: null }]);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM threads WHERE tenant_id=ANY($1::text[])',
          [[local, foreign]],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
