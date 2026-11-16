import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import type { RuleDraftInput } from '@caixiaozhi/contracts/rules';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { createIdentityService } from '../../packages/identity/src/index.js';
import {
  createFinanceActionHandlers,
  createFinanceService,
} from '../../packages/finance/src/index.js';
import { personalMealsDsl } from '../../packages/finance/src/rule-seeds.js';
import { createActionService } from '../../packages/action-service/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuleRoutes } from '../../apps/api/src/modules/rules/routes.js';
import { createIdentityHttpContext } from '../../apps/api/src/modules/identity/routes.js';

const database = createDatabase(loadConfig().databaseUrl),
  tenant = `rule-read-${randomUUID()}`,
  identity = createIdentityService(database, {
    sessionSecret: 'rule-read-diff-integration-secret-long-enough',
    appMode: 'demo',
    demoAccessEnabled: true,
  }),
  queue = createDurableQueue(database),
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
      kinds.map((kind) => `${prefix}${kind}`),
      leaseMs,
    );
    return job ? { ...job, kind: job.kind.slice(prefix.length) } : null;
  },
};
const unused = async (): Promise<never> => {
  throw new Error('规则读取测试不访问业务系统。');
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
  database: async () => {},
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
const actors: Record<string, ActorContext> = {},
  cookies: Record<string, string> = {};
function companyInput(
  departments: string[],
  threshold = '100000',
  name = `公司规则-${randomUUID()}`,
): RuleDraftInput {
  const personal = personalMealsDsl(departments, threshold);
  return {
    name,
    level: 'company',
    category: 'meals',
    source_kind: 'manual_company_decision',
    source_citation_ids: [],
    dsl_json: {
      ...personal,
      outcome_mode: 'mandatory_check',
      failure_kind: 'violation',
    },
  };
}
async function createCompany(departments: string[], threshold = '100000') {
  return finance.rules.createDraft(
    actors['u-liu']!,
    companyInput(departments, threshold),
    randomUUID(),
  );
}
// 用持久化发布版夹具隔离读权限；完整证明和动作发布另有本文件最后一项覆盖。
async function publishFixture(rule: any) {
  await database.pool.query(
    "UPDATE rule_versions SET publication_state='published' WHERE tenant_id=$1 AND id=$2",
    [tenant, rule.draft_version_id],
  );
  await database.pool.query(
    "UPDATE rule_definitions SET active_version_id=draft_version_id,draft_version_id=NULL,lifecycle='active',version=version+1 WHERE tenant_id=$1 AND id=$2",
    [tenant, rule.id],
  );
  return finance.rules.getRule(actors['u-liu']!, rule.id);
}
const get = (user: string, id: string, suffix = '') =>
  app.inject({
    url: `/api/v1/rules/${id}${suffix}`,
    headers: { cookie: cookies[user]! },
  });
describe('公司规则版本读权限与真实语义diff', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    for (const user of ['u-liu', 'u-zhang', 'u-li', 'u-chen']) {
      const session = await identity.loginDemo(user, undefined, {
        tenantId: tenant,
        environmentId: tenant,
        generation: 1,
      });
      actors[user] = await identity.getActor(session.session_token);
      cookies[user] = `caixiaozhi_session=${session.session_token}`;
    }
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
      await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
        tenant,
      ]);
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

  it('同部门员工不能手写ID读取未发布草稿，列表与详情使用同一守卫', async () => {
    const rule = await createCompany(['dept-sales']);
    for (const user of ['u-zhang', 'u-li', 'u-chen']) {
      const response = await get(user, rule.id);
      expect(response.statusCode, response.body).toBe(404);
      const list = await app.inject({
        url: '/api/v1/rules',
        headers: { cookie: cookies[user]! },
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().data.items.map((item: any) => item.id)).not.toContain(
        rule.id,
      );
    }
    expect((await get('u-liu', rule.id)).statusCode).toBe(200);
  });

  it('跨部门发布版详情和diff均为404，财务管理范围可以读取', async () => {
    const rule = await publishFixture(await createCompany(['dept-tech']));
    for (const user of ['u-zhang', 'u-li']) {
      expect((await get(user, rule.id)).statusCode).toBe(404);
      expect(
        (await get(user, rule.id, '/diff?from_version=1&to_version=1'))
          .statusCode,
      ).toBe(404);
    }
    expect((await get('u-chen', rule.id)).statusCode).toBe(200);
    expect((await get('u-liu', rule.id)).statusCode).toBe(200);
  });

  it('已发布版保持可见，但隐藏新草稿的名称、分类、问题和指针', async () => {
    const active = await publishFixture(await createCompany(['dept-sales'])),
      secret = '机密新草稿名称-仅技术部门',
      draft = await finance.rules.saveDraft(
        actors['u-liu']!,
        active.id,
        active.version,
        {
          ...companyInput(['dept-tech'], '900000', secret),
          category: 'invoice',
        },
        randomUUID(),
      );
    await database.pool.query(
      'UPDATE rule_definitions SET original_intent=$3,unresolved_questions=$4::jsonb WHERE tenant_id=$1 AND id=$2',
      [
        tenant,
        active.id,
        '内部敏感自然语言意图',
        JSON.stringify(['内部敏感问题']),
      ],
    );
    const response = await get('u-li', active.id);
    expect(response.statusCode, response.body).toBe(200);
    const visible = response.json().data;
    expect(visible).toMatchObject({
      active_version_id: active.active_version_id,
      draft_version_id: null,
      lifecycle: 'active',
      original_intent: null,
      questions: [],
    });
    expect(visible.versions.map((version: any) => version.id)).toEqual([
      active.active_version_id,
    ]);
    expect(visible.name).not.toBe(secret);
    expect(visible.name).toBe(active.name);
    expect(visible.category).toBe('meals');
    expect(visible.versions[0]).toMatchObject({
      display_name: active.name,
      category: 'meals',
      metadata_status: 'trusted',
    });
    expect(response.body).not.toContain('内部敏感');
    expect((await get('u-chen', active.id)).statusCode).toBe(404);
    const managed = (await get('u-liu', active.id)).json().data;
    expect(managed).toMatchObject({
      name: secret,
      category: 'invoice',
      draft_version_id: draft.draft_version_id,
      original_intent: '内部敏感自然语言意图',
      questions: ['内部敏感问题'],
    });
    expect(
      (await get('u-li', active.id, '/diff?from_version=1&to_version=2'))
        .statusCode,
    ).toBe(404);
  });

  it('各历史版本独立过滤，diff保留真实from/to而不互相覆盖', async () => {
    const first = await publishFixture(await createCompany(['dept-tech'])),
      second = await finance.rules.saveDraft(
        actors['u-liu']!,
        first.id,
        first.version,
        companyInput(['dept-sales'], '200000'),
        randomUUID(),
      );
    await publishFixture(second);
    const sales = (await get('u-li', first.id)).json().data,
      tech = (await get('u-chen', first.id)).json().data;
    expect(
      sales.versions.map((version: any) => version.version_number),
    ).toEqual([2]);
    expect(tech.versions.map((version: any) => version.version_number)).toEqual(
      [1],
    );
    expect(tech.active_version_id).toBeNull();
    expect(
      (await get('u-li', first.id, '/diff?from_version=1&to_version=2'))
        .statusCode,
    ).toBe(404);
    const diff = await get(
      'u-liu',
      first.id,
      '/diff?from_version=1&to_version=2',
    );
    expect(diff.statusCode, diff.body).toBe(200);
    expect(diff.json().data).toMatchObject({
      from: {
        id: first.active_version_id,
        version_number: 1,
        mapping_basis: 'unknown',
        dsl_json: {
          predicate: { right: { value: { amount_minor: '100000' } } },
        },
      },
      to: {
        id: second.draft_version_id,
        version_number: 2,
        mapping_basis: 'unknown',
        dsl_json: {
          predicate: { right: { value: { amount_minor: '200000' } } },
        },
      },
    });
    expect(diff.json().data.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'threshold' }),
        expect.objectContaining({ kind: 'scope' }),
      ]),
    );
    expect(diff.json().data.warnings.join('')).toContain('无法判定');
  });

  it('个人规则仍只对owner可读，不因同部门共享', async () => {
    const rule = await finance.rules.createDraft(
      actors['u-zhang']!,
      {
        name: '本人餐饮提醒',
        level: 'personal',
        category: 'meals',
        dsl_json: personalMealsDsl(['dept-sales']),
        source_kind: 'personal',
        source_citation_ids: [],
      },
      randomUUID(),
    );
    expect((await get('u-zhang', rule.id)).statusCode).toBe(200);
    for (const user of ['u-li', 'u-liu'])
      expect((await get(user, rule.id)).statusCode).toBe(404);
  });

  it('缺少可信历史元数据时普通读取失败关闭，管理者看到待修复标记', async () => {
    const first = await publishFixture(await createCompany(['dept-sales'])),
      second = await finance.rules.saveDraft(
        actors['u-liu']!,
        first.id,
        first.version,
        companyInput(['dept-sales'], '200000', '可信第二版名称'),
        randomUUID(),
      );
    await publishFixture(second);
    // 事务临时表模拟迁移前缺历史元数据的真实PG记录；不禁用任何正式表触发器。
    await database.db.transaction(async (tx) => {
      await tx.execute(
        sql`CREATE TEMP TABLE rule_definitions (LIKE public.rule_definitions INCLUDING ALL) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`CREATE TEMP TABLE rule_versions (LIKE public.rule_versions INCLUDING ALL) ON COMMIT DROP`,
      );
      await tx.execute(
        sql`INSERT INTO pg_temp.rule_definitions SELECT * FROM public.rule_definitions WHERE tenant_id=${tenant} AND id=${first.id}`,
      );
      await tx.execute(
        sql`INSERT INTO pg_temp.rule_versions SELECT * FROM public.rule_versions WHERE tenant_id=${tenant} AND rule_id=${first.id}`,
      );
      await tx.execute(
        sql`UPDATE pg_temp.rule_versions SET display_name=NULL,category=NULL WHERE version_number=1`,
      );
      const visible = await finance.rules.getRule(
          actors['u-li']!,
          first.id,
          tx,
        ),
        managed = await finance.rules.getRule(actors['u-liu']!, first.id, tx);
      expect(visible.name).toBe('可信第二版名称');
      expect(
        visible.versions.map((version: any) => version.version_number),
      ).toEqual([2]);
      expect(managed.versions[0]).toMatchObject({
        display_name: null,
        category: null,
        metadata_status: 'unavailable',
      });
      await tx.execute(
        sql`UPDATE pg_temp.rule_versions SET display_name=NULL,category=NULL WHERE version_number=2`,
      );
      await expect(
        finance.rules.getRule(actors['u-li']!, first.id, tx),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('版本名称分类不可原地改写，新版本不得遗漏可信元数据', async () => {
    const rule = await createCompany(['dept-sales']);
    await expect(
      database.pool.query(
        'UPDATE rule_versions SET display_name=$3 WHERE tenant_id=$1 AND id=$2',
        [tenant, rule.draft_version_id, '试图覆盖旧名称'],
      ),
    ).rejects.toThrow('rule version display metadata is immutable');
    await expect(
      database.pool.query(
        `INSERT INTO rule_versions(tenant_id,id,rule_id,version_number,dsl_json,content_hash,source_kind,source_citation_ids,explanation,publication_state)
         SELECT tenant_id,$3,rule_id,version_number+1,dsl_json,content_hash,source_kind,source_citation_ids,explanation,publication_state
         FROM rule_versions WHERE tenant_id=$1 AND id=$2`,
        [tenant, rule.draft_version_id, randomUUID()],
      ),
    ).rejects.toThrow('new rule version requires trusted display metadata');
    expect((await get('u-liu', rule.id)).json().data.name).toBe(rule.name);
  });

  it('两个版本分别绑定真实测试与发布映射快照，不用当前映射填旧版', async () => {
    const actor = actors['u-zhang']!,
      rule = await finance.rules.createDraft(
        actor,
        {
          name: '本人独立映射快照',
          level: 'personal',
          category: 'meals',
          dsl_json: personalMealsDsl(['dept-sales']),
          source_kind: 'personal',
          source_citation_ids: [],
        },
        randomUUID(),
      ),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: 'boundary-v1' },
        randomUUID(),
      );
    while (await finance.processNextJob('rule-read-mapping-worker')) {}
    const proof = (await finance.ruleTests.get(actor, rule.id, task.task_id))
        .proof!,
      actions = createActionService(database.db, {
        signingSecret: 'rule-read-diff-action-signing-secret-long-enough',
        freshActor: (a) => identity.requireCurrentActor(a),
        assertResourceAccess: async (a, _operation, ref) => {
          await finance.rules.getRule(a, ref.id);
        },
      }),
      handlers = createFinanceActionHandlers(finance);
    actions.registerHandler('rule.enable', handlers['rule.enable']!);
    const prepared = await actions.prepareAction(actor, {
      action: 'rule.enable',
      resource_refs: [{ type: 'rule', id: rule.id, version: rule.version }],
      args: {
        rule_id: rule.id,
        expected_version: rule.version,
        draft_hash: proof.draft_hash,
        test_run_id: proof.test_run_id,
      },
      idempotency_key: randomUUID(),
    });
    const review = await actions.getReview(actor, prepared.confirmation_id, {
      channel: 'browser',
    });
    const result = await actions.confirmAction(actor, review.confirmation_id, {
      expected_version: review.version,
      summary_hash: review.summary_hash,
      confirmation_token: review.confirmation_token!,
    });
    expect(result.state).toBe('succeeded');
    await database.pool.query(
      `INSERT INTO field_mapping_versions(tenant_id,id,mapping_id,version_number,mapping_json,content_hash,confirmed_by)
      VALUES($1,$2,'history-map',1,'{"module":"expense_claim"}'::jsonb,'history-map-content',$3)`,
      [tenant, randomUUID(), actor.user_id],
    );
    await database.pool.query(
      "UPDATE finance_revision_guards SET revision=revision+1 WHERE tenant_id=$1 AND id='mapping'",
      [tenant],
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
        randomUUID(),
      );
    await finance.ruleTests.start(
      actor,
      rule.id,
      { expected_version: next.version, test_set_id: 'boundary-v1' },
      randomUUID(),
    );
    while (await finance.processNextJob('rule-read-mapping-worker')) {}
    const response = await get(
      'u-zhang',
      rule.id,
      '/diff?from_version=1&to_version=2',
    );
    expect(response.statusCode, response.body).toBe(200);
    const diff = response.json().data;
    expect(diff.from.mapping_basis).toBe('activation_proof');
    expect(diff.to.mapping_basis).toBe('latest_completed_test');
    expect(diff.from.mapping_snapshot.mappings).toEqual([]);
    expect(diff.to.mapping_snapshot.mappings).toEqual([
      expect.objectContaining({ content_hash: 'history-map-content' }),
    ]);
    expect(diff.to.mapping_snapshot.revision).toBe(
      diff.from.mapping_snapshot.revision + 1,
    );
    expect(diff.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'mapping' })]),
    );
  });
});
