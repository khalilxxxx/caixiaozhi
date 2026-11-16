import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createIdentityService } from '../../packages/identity/src/index.js';
import {
  createFinanceService,
  createFinanceActionHandlers,
} from '../../packages/finance/src/index.js';
import { personalMealsDsl } from '../../packages/finance/src/rule-seeds.js';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { RuleTestStartSchema } from '@caixiaozhi/contracts/rules';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuleRoutes } from '../../apps/api/src/modules/rules/routes.js';
import { createIdentityHttpContext } from '../../apps/api/src/modules/identity/routes.js';
import { createActionService } from '../../packages/action-service/src/index.js';
const database = createDatabase(loadConfig().databaseUrl),
  tenant = `rule-tests-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'rule-test-task-integration-secret-long-enough',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const queue = createDurableQueue(database),
  prefix = `integration:${tenant}:`;
const isolated: ReturnType<typeof createDurableQueue> = {
  ...queue,
  enqueueInTransaction: async (tx, input) => {
    const job = await queue.enqueueInTransaction(tx, {
      ...input,
      kind: `${prefix}${input.kind}`,
    });
    return { ...job, kind: input.kind };
  },
  claim: async (worker, kinds, leaseMs) => {
    const job = await queue.claim(
      worker,
      kinds.map((k) => `${prefix}${k}`),
      leaseMs,
    );
    return job ? { ...job, kind: job.kind.slice(prefix.length) } : null;
  },
};
const unused = async (): Promise<never> => {
  throw new Error('本任务不读取业务单据。');
};
const finance = createFinanceService(database, {
  identity,
  jobs: isolated,
  business: {
    getPreauditInput: unused,
    getApprovalTask: unused,
    listCurrentApprovalDocuments: unused,
  },
});
const app = createApp({
  database: async () => {
    await database.pool.query('SELECT 1');
  },
  storage: async () => {},
  dataMode: 'demo',
});
registerRuleRoutes(app, {
  finance,
  identity: createIdentityHttpContext(identity, {
    appMode: 'test',
    cookieSecure: false,
  }),
});
let actor: ActorContext,
  other: ActorContext,
  cookie: string,
  otherCookie: string,
  csrf: string;
const key = () => randomUUID();
async function draft(threshold = '100000') {
  return finance.rules.createDraft(
    actor,
    {
      name: `分边界-${key()}`,
      level: 'personal',
      category: 'meals',
      dsl_json: personalMealsDsl(['dept-sales'], threshold),
      source_kind: 'personal',
      source_citation_ids: [],
    },
    key(),
  );
}
describe('规则测试真实持久任务与证明边界', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    const [one, two] = await Promise.all(
      ['u-zhang', 'u-li'].map((id) =>
        identity.loginDemo(id, undefined, {
          tenantId: tenant,
          environmentId: tenant,
          generation: 1,
        }),
      ),
    );
    [actor, other] = await Promise.all([
      identity.getActor(one!.session_token),
      identity.getActor(two!.session_token),
    ]);
    cookie = `caixiaozhi_session=${one!.session_token}`;
    otherCookie = `caixiaozhi_session=${two!.session_token}`;
    csrf = one!.csrf_token;
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    for (const table of [
      'action_audit',
      'action_attempts',
      'action_receipts',
      'action_items',
    ])
      await database.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`DELETE FROM actions WHERE tenant_id=${tenant}`);
      await tx.execute(
        sql`DELETE FROM confirmations WHERE tenant_id=${tenant}`,
      );
    });
    await database.pool.query('DELETE FROM durable_jobs WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenant],
    );
    await database.close();
  });
  it('HTTP命令拒绝cases/scripts与未知测试集，未执行前没有proof', async () => {
    expect(
      RuleTestStartSchema.safeParse({
        expected_version: 1,
        test_set_id: 'boundary-v1',
        cases: [],
      }).success,
    ).toBe(false);
    const rule = await draft();
    await expect(
      finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'not-registered' },
        key(),
      ),
    ).rejects.toBeTruthy();
    const task = await finance.ruleTests.start(
      actor,
      rule.id,
      { expected_version: 1, test_set_id: 'boundary-v1' },
      key(),
    );
    expect(task.status).toBe('queued');
    expect(task.test_run_id).toBe(task.task_id);
    const view = await finance.ruleTests.get(actor, rule.id, task.task_id);
    expect(view.proof).toBeNull();
    expect(view.completed_cases).toBe(0);
    expect(
      (
        await database.db.execute(
          sql`SELECT count(*)::int AS count FROM rule_test_runs WHERE tenant_id=${tenant} AND id=${task.test_run_id}`,
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });
  it('同键与同内容重复调用只产生同一真实任务，四边界按分而非整元', async () => {
    const rule = await draft(),
      request = { expected_version: 1, test_set_id: 'boundary-v1' as const },
      requestKey = key();
    const [one, two] = await Promise.all([
      finance.ruleTests.start(actor, rule.id, request, requestKey),
      finance.ruleTests.start(actor, rule.id, request, requestKey),
    ]);
    expect(two.task_id).toBe(one.task_id);
    const repeated = await finance.ruleTests.start(
      actor,
      rule.id,
      request,
      key(),
    );
    expect(repeated.task_id).toBe(one.task_id);
    const job = await isolated.claim('rule-test-worker', ['rules.test']);
    expect(job).toBeTruthy();
    // 首个测试留有未处理任务；按任务ID领取本项，仍使用真实DB租约。
    if (job) {
      await finance.handleJob(job);
      await isolated.finish(
        job.id,
        'rule-test-worker',
        job.lease_epoch,
        'succeeded',
      );
    }
    while (await finance.processNextJob('rule-test-drain')) {}
    const result = await finance.ruleTests.get(actor, rule.id, one.task_id);
    expect(result.status).toBe('completed');
    expect(result.proof?.passed).toBe(true);
    expect(result.cases.map((c) => c.amount_minor)).toEqual([
      '99999',
      '100000',
      '100001',
      null,
    ]);
    expect(result.proof?.results.map((r) => r.truth)).toEqual([
      'false',
      'false',
      'true',
      'unknown',
    ]);
    await expect(
      finance.ruleTests.get(other, rule.id, one.task_id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const restarted = createFinanceService(database, {
      identity,
      jobs: isolated,
      business: {
        getPreauditInput: unused,
        getApprovalTask: unused,
        listCurrentApprovalDocuments: unused,
      },
    });
    expect(
      (await restarted.ruleTests.get(actor, rule.id, one.task_id)).proof
        ?.test_run_id,
    ).toBe(one.test_run_id);
  });
  it('旧草稿或映射修订失效，Worker不写可用证明', async () => {
    const rule = await draft(),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      );
    await finance.rules.saveDraft(
      actor,
      rule.id,
      1,
      {
        name: rule.name,
        level: 'personal',
        category: 'meals',
        dsl_json: personalMealsDsl(['dept-sales'], '200000'),
        source_kind: 'personal',
        source_citation_ids: [],
      },
      key(),
    );
    while (await finance.processNextJob('stale-draft-worker')) {}
    expect(
      (await finance.ruleTests.get(actor, rule.id, task.task_id)).status,
    ).toBe('stale');
    expect(
      (
        await database.db.execute(
          sql`SELECT count(*)::int AS count FROM rule_test_runs WHERE tenant_id=${tenant} AND id=${task.test_run_id}`,
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    const next = await draft(),
      mappingTask = await finance.ruleTests.start(
        actor,
        next.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      );
    await database.db.execute(
      sql`UPDATE finance_revision_guards SET revision=revision+1 WHERE tenant_id=${tenant} AND id='mapping'`,
    );
    while (await finance.processNextJob('stale-mapping-worker')) {}
    expect(
      (await finance.ruleTests.get(actor, next.id, mappingTask.task_id)).status,
    ).toBe('stale');
  });
  it('失去租约的旧Worker不能提交proof，新Worker恢复只写一次', async () => {
    const rule = await draft(),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      ),
      old = await isolated.claim('old-rule-worker', ['rules.test']);
    expect(old?.id).toBe(task.job_id);
    if (!old) throw new Error('未领取规则测试任务');
    await database.db.execute(
      sql`UPDATE durable_jobs SET lease_until=now()-interval '1 second' WHERE id=${old.id}`,
    );
    const fresh = await isolated.claim('new-rule-worker', ['rules.test']);
    if (!fresh) throw new Error('未恢复规则测试任务');
    await expect(finance.ruleTests.processJob(old)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(
      (await finance.ruleTests.get(actor, rule.id, task.task_id)).proof,
    ).toBeNull();
    await finance.ruleTests.processJob(fresh);
    await isolated.finish(
      fresh.id,
      'new-rule-worker',
      fresh.lease_epoch,
      'succeeded',
    );
    expect(
      (await finance.ruleTests.get(actor, rule.id, task.task_id)).proof?.passed,
    ).toBe(true);
    expect(
      (
        await database.db.execute(
          sql`SELECT count(*)::int AS count FROM rule_test_runs WHERE tenant_id=${tenant} AND id=${task.test_run_id}`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
  it('真实HTTP返回202且轮询完成后才提供proof，拒绝任意样例和越权读取', async () => {
    const rule = await draft(),
      url = `/api/v1/rules/${rule.id}/tests`,
      headers = {
        cookie,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
        'idempotency-key': key(),
      };
    for (const body of [
      { expected_version: 1, test_set_id: 'unknown' },
      { expected_version: 1, test_set_id: 'boundary-v1', cases: [] },
      {
        expected_version: 1,
        test_set_id: 'boundary-v1',
        script: 'return true',
      },
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, 'idempotency-key': key() },
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
    }
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { expected_version: 1, test_set_id: 'boundary-v1' },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const task = accepted.json().data;
    const pending = await app.inject({
      url: `${url}/${task.task_id}`,
      headers: { cookie },
    });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().data.proof).toBeNull();
    expect(
      (
        await app.inject({
          url: `${url}/${task.task_id}`,
          headers: { cookie: otherCookie },
        })
      ).statusCode,
    ).toBe(404);
    while (await finance.processNextJob('http-rule-test-worker')) {}
    const completed = await app.inject({
      url: `${url}/${task.task_id}`,
      headers: { cookie },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().data).toMatchObject({
      status: 'completed',
      completed_cases: 4,
      proof: { passed: true, test_run_id: task.task_id },
    });
  });
  it('任务未完成时统一确认处理器拒绝准备启用', async () => {
    const rule = await draft(),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      ),
      handler = createFinanceActionHandlers(finance)['rule.enable']!;
    const args = {
      rule_id: rule.id,
      expected_version: 1,
      draft_hash: rule.versions[0].content_hash,
      test_run_id: task.task_id,
    };
    await expect(
      handler.validate(
        actor,
        args,
        [{ type: 'rule', id: rule.id, version: 1 }],
        database.db,
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    while (await finance.processNextJob('pending-proof-drain')) {}
    await expect(
      handler.validate(
        actor,
        args,
        [{ type: 'rule', id: rule.id, version: 1 }],
        database.db,
      ),
    ).resolves.toBeTruthy();
  });
  it('映射快照内容变化即使revision未变也不能用旧proof启用', async () => {
    const rule = await draft(),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      );
    while (await finance.processNextJob('mapping-proof-worker')) {}
    const completed = await finance.ruleTests.get(actor, rule.id, task.task_id);
    expect(completed.proof?.passed).toBe(true);
    await database.db.execute(
      sql`INSERT INTO field_mapping_versions(tenant_id,id,mapping_id,version_number,mapping_json,content_hash,confirmed_by) VALUES(${tenant},${key()},'snapshot-map',1,'{"module":"expense_claim"}'::jsonb,'changed-mapping-content',${actor.user_id})`,
    );
    expect(
      (await finance.ruleTests.get(actor, rule.id, task.task_id)).status,
    ).toBe('stale');
    await expect(
      database.db.transaction((tx) =>
        finance.rules.activateRule(
          actor,
          {
            rule_id: rule.id,
            expected_version: 1,
            draft_hash: completed.proof!.draft_hash,
            test_run_id: task.task_id,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
  it('规则启用与发布拒绝disable和未知字段，既有active与动作账本不变', async () => {
    const rule = await draft(),
      first = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      );
    while (await finance.processNextJob('strict-first-test')) {}
    const firstProof = (
      await finance.ruleTests.get(actor, rule.id, first.task_id)
    ).proof!;
    await database.db.transaction((tx) =>
      finance.rules.activateRule(
        actor,
        {
          rule_id: rule.id,
          expected_version: 1,
          draft_hash: firstProof.draft_hash,
          test_run_id: firstProof.test_run_id,
        },
        tx,
      ),
    );
    const active = await finance.rules.getRule(actor, rule.id),
      next = await finance.rules.saveDraft(
        actor,
        rule.id,
        active.version,
        {
          name: rule.name,
          level: 'personal',
          category: 'meals',
          dsl_json: personalMealsDsl(['dept-sales'], '200000'),
          source_kind: 'personal',
          source_citation_ids: [],
        },
        key(),
      );
    const tested = await finance.ruleTests.start(
      actor,
      rule.id,
      { expected_version: next.version, test_set_id: 'boundary-v1' },
      key(),
    );
    while (await finance.processNextJob('strict-draft-test')) {}
    const proof = (await finance.ruleTests.get(actor, rule.id, tested.task_id))
        .proof!,
      actions = createActionService(database.db, {
        signingSecret: 'strict-rule-action-integration-signing-secret',
        freshActor: (a) => identity.requireCurrentActor(a),
        assertResourceAccess: async (a, _operation, ref) => {
          await finance.rules.getRule(a, ref.id);
        },
      }),
      handlers = createFinanceActionHandlers(finance);
    actions.registerHandler('rule.enable', handlers['rule.enable']!);
    actions.registerHandler('rule.publish', handlers['rule.publish']!);
    const args = {
      rule_id: rule.id,
      expected_version: next.version,
      draft_hash: proof.draft_hash,
      test_run_id: proof.test_run_id,
    };
    for (const action of ['rule.enable', 'rule.publish'] as const)
      for (const extra of [{ disable: true }, { unexpected: 'field' }]) {
        await expect(
          actions.prepareAction(actor, {
            action,
            resource_refs: [
              { type: 'rule', id: rule.id, version: next.version },
            ],
            args: { ...args, ...extra },
            idempotency_key: key(),
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        const current = await finance.rules.getRule(actor, rule.id);
        expect(current).toMatchObject({
          lifecycle: 'ready',
          version: next.version,
          active_version_id: active.active_version_id,
          draft_version_id: next.draft_version_id,
        });
      }
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int count FROM actions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int count FROM confirmations WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });
  it('权限版本变化后新会话也不能复用旧任务proof', async () => {
    const rule = await draft(),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: 1, test_set_id: 'boundary-v1' },
        key(),
      );
    while (await finance.processNextJob('authz-proof-worker')) {}
    const completed = await finance.ruleTests.get(actor, rule.id, task.task_id);
    expect(completed.proof?.passed).toBe(true);
    await database.db.execute(
      sql`UPDATE identities SET authz_version=authz_version+1 WHERE tenant_id=${tenant} AND id=${actor.user_id}`,
    );
    const session = await identity.loginDemo(actor.user_id, undefined, {
        tenantId: tenant,
        environmentId: tenant,
        generation: 1,
      }),
      fresh = await identity.getActor(session.session_token);
    expect(
      (await finance.ruleTests.get(fresh, rule.id, task.task_id)).status,
    ).toBe('stale');
    await expect(
      database.db.transaction((tx) =>
        finance.rules.activateRule(
          fresh,
          {
            rule_id: rule.id,
            expected_version: 1,
            draft_hash: completed.proof!.draft_hash,
            test_run_id: task.task_id,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
});
