import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import type { SrsInput, Truth } from '@caixiaozhi/contracts/rules';
import { createIdentityService } from '../../packages/identity/src/index.js';
import {
  createFinanceService,
  createFinanceActionHandlers,
} from '../../packages/finance/src/index.js';
import { BASELINE_RULES } from '../../packages/finance/src/rule-seeds.js';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuleRoutes } from '../../apps/api/src/modules/rules/routes.js';
import { createIdentityHttpContext } from '../../apps/api/src/modules/identity/routes.js';

const database = createDatabase(loadConfig().databaseUrl),
  tenant = `manual-rule-tests-${randomUUID()}`,
  foreignTenant = `manual-rule-tests-${randomUUID()}`,
  identity = createIdentityService(database, {
    sessionSecret: 'manual-rule-tests-integration-secret-long-enough',
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
  throw new Error('样例测试不读取业务单据');
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
  foreign: ActorContext,
  companyOwner: ActorContext,
  cookie: string,
  csrf: string;
const key = () => randomUUID();
function lodgingInput(
  amountMinor: string,
  roomNights: string | null,
): SrsInput {
  const amount = { amount_minor: amountMinor, currency: 'CNY' as const };
  return {
    schema_version: 1,
    document: { type: 'expense_claim', id: `manual-${key()}`, version: 1 },
    business_date: '2026-11-01',
    applicant_id: 'u-zhang',
    department_id: 'dept-sales',
    total_amount: amount,
    expense_items: [
      {
        id: 'lodging-line',
        category: 'lodging',
        source_expense_type: 'lodging',
        amount,
        invoice_refs: [],
        spent_on: '2026-11-01',
        room_nights: roomNights,
        oa_request_ref: null,
      },
    ],
    invoices: [],
    external_facts: {},
    field_states: {},
  };
}
function cases() {
  return [
    {
      name: '两间夜正常',
      input: lodgingInput('150000', '2'),
      expected_truth: 'true' as Truth,
    },
    {
      name: '两间夜超额1分',
      input: lodgingInput('160001', '2'),
      expected_truth: 'false' as Truth,
    },
    {
      name: '两间夜恰等上限',
      input: lodgingInput('160000', '2'),
      expected_truth: 'true' as Truth,
    },
    {
      name: '间夜数未知',
      input: lodgingInput('150000', null),
      expected_truth: 'unknown' as Truth,
    },
  ];
}
async function draft() {
  const original = structuredClone(
    BASELINE_RULES.find((rule) => rule.category === 'lodging')!.dsl,
  );
  if (original.outcome_mode !== 'mandatory_check')
    throw new Error('住宿夹具必须是公司必查规则。');
  const { failure_kind: _failureKind, ...condition } = original;
  const dsl = { ...condition, outcome_mode: 'attention_trigger' as const };
  dsl.applicability.department_ids = ['dept-sales'];
  return finance.rules.createDraft(
    actor,
    {
      name: `人工住宿-${key()}`,
      level: 'personal',
      category: 'lodging',
      dsl_json: dsl,
      source_kind: 'personal',
      source_citation_ids: [],
    },
    key(),
  );
}
describe('复杂规则不可变人工样例集合', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    await identity.seedDemoIdentity({
      tenantId: foreignTenant,
      environmentId: foreignTenant,
      generation: 1,
    });
    // 本测试租户中独立授予第二位管理者公司规则权限，验证集合仍仅属登记者。
    await database.pool.query(
      "INSERT INTO grants(tenant_id,id,subject_id,capability,scope_type,scope_ids,effect) VALUES($1,$2,'u-zhang','rule.manage.company','department',$3::jsonb,'allow')",
      [tenant, key(), JSON.stringify(['dept-sales'])],
    );
    const session = await identity.loginDemo('u-zhang', undefined, {
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    actor = await identity.getActor(session.session_token);
    const login = async (userId: string, tenantId = tenant) =>
      identity.getActor(
        (
          await identity.loginDemo(userId, undefined, {
            tenantId,
            environmentId: tenantId,
            generation: 1,
          })
        ).session_token,
      );
    [other, foreign, companyOwner] = await Promise.all([
      login('u-li'),
      login('u-zhang', foreignTenant),
      login('u-liu'),
    ]);
    cookie = `caixiaozhi_session=${session.session_token}`;
    csrf = session.csrf_token;
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await database.pool.query(
      'DELETE FROM durable_jobs WHERE tenant_id=ANY($1::text[])',
      [[tenant, foreignTenant]],
    );
    await database.pool.query(
      'DELETE FROM outbox_events WHERE tenant_id=ANY($1::text[])',
      [[tenant, foreignTenant]],
    );
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=ANY($1::text[])',
      [[tenant, foreignTenant]],
    );
    await database.close();
  });
  it('HTTP登记独立人工预期并经真实持久队列得到复杂for_each证明', async () => {
    const rule = await draft(),
      samples = cases();
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/rules/${rule.id}/test-sets`,
      headers: {
        cookie,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
        'idempotency-key': key(),
      },
      payload: {
        expected_version: rule.version,
        name: '住宿人工四项',
        cases: samples,
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const set = registered.json().data;
    expect(set).toMatchObject({
      name: '住宿人工四项',
      status: 'current',
      case_count: 4,
      draft_version_id: rule.draft_version_id,
      cases: samples,
    });
    const task = await finance.ruleTests.start(
      actor,
      rule.id,
      { expected_version: rule.version, test_set_id: set.id },
      key(),
    );
    expect(
      (await finance.ruleTests.get(actor, rule.id, task.task_id)).proof,
    ).toBeNull();
    while (await finance.processNextJob('manual-rule-worker')) {}
    const completed = await finance.ruleTests.get(actor, rule.id, task.task_id);
    expect(completed).toMatchObject({
      status: 'completed',
      total_cases: 4,
      completed_cases: 4,
      proof: { passed: true },
    });
    expect(completed.proof!.results.map((result) => result.truth)).toEqual([
      'true',
      'false',
      'true',
      'unknown',
    ]);
    expect(
      (await finance.ruleTests.listTestSets(actor, rule.id)).items.map(
        (item) => item.id,
      ),
    ).toContain(set.id);
  });
  it('仅改名称也使旧集合及证明失效，排队Worker不提交旧草稿proof', async () => {
    const rule = await draft(),
      register = (name: string) =>
        finance.ruleTests.createTestSet(
          actor,
          rule.id,
          { expected_version: rule.version, name, cases: cases() },
          key(),
        ),
      set = await register('已完成集合'),
      tested = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: set.id },
        key(),
      );
    while (await finance.processNextJob('manual-before-rename')) {}
    const proof = (await finance.ruleTests.get(actor, rule.id, tested.task_id))
      .proof!;
    expect(proof.passed).toBe(true);
    const pendingSet = await register('尚未执行集合'),
      pending = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: pendingSet.id },
        key(),
      ),
      version = rule.versions.find(
        (value: { id: string }) => value.id === rule.draft_version_id,
      ),
      next = await finance.rules.saveDraft(
        actor,
        rule.id,
        rule.version,
        {
          name: `${rule.name}-改名`,
          level: rule.level,
          category: rule.category,
          dsl_json: version.dsl_json,
          source_kind: version.source_kind,
          source_citation_ids: version.source_citation_ids,
        },
        key(),
      );
    expect(next.draft_version_id).not.toBe(rule.draft_version_id);
    expect(
      next.versions.find(
        (value: { id: string }) => value.id === next.draft_version_id,
      ).content_hash,
    ).toBe(set.draft_hash);
    await expect(
      finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: set.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: next.version, test_set_id: set.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    while (await finance.processNextJob('manual-after-rename')) {}
    expect(
      await finance.ruleTests.get(actor, rule.id, pending.task_id),
    ).toMatchObject({ status: 'stale', proof: null });
    expect(
      (await finance.ruleTests.listTestSets(actor, rule.id)).items.every(
        (item) => item.status === 'stale',
      ),
    ).toBe(true);
    await expect(
      database.db.transaction((tx) =>
        finance.rules.activateRule(
          actor,
          {
            rule_id: rule.id,
            expected_version: next.version,
            draft_hash: set.draft_hash,
            test_run_id: proof.test_run_id,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
  it('个人他人、跨租户以及有同公司管理权的其他owner均不可使用登记集合', async () => {
    const rule = await draft(),
      payload = {
        expected_version: rule.version,
        name: '所有者私有样例',
        cases: cases(),
      },
      set = await finance.ruleTests.createTestSet(
        actor,
        rule.id,
        payload,
        key(),
      );
    for (const denied of [other, foreign]) {
      await expect(
        finance.ruleTests.createTestSet(denied, rule.id, payload, key()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        finance.ruleTests.listTestSets(denied, rule.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        finance.ruleTests.start(
          denied,
          rule.id,
          { expected_version: rule.version, test_set_id: set.id },
          key(),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const dsl = structuredClone(
      BASELINE_RULES.find((item) => item.category === 'lodging')!.dsl,
    );
    dsl.applicability.department_ids = ['dept-sales'];
    const company = await finance.rules.createDraft(
        companyOwner,
        {
          name: '公司人工住宿',
          level: 'company',
          category: 'lodging',
          dsl_json: dsl,
          source_kind: 'manual_company_decision',
          source_citation_ids: [],
        },
        key(),
      ),
      companySet = await finance.ruleTests.createTestSet(
        companyOwner,
        company.id,
        { ...payload, expected_version: company.version },
        key(),
      );
    expect(
      (await finance.rules.getTestTarget(actor, company.id, company.version))
        .draft.id,
    ).toBe(company.draft_version_id);
    expect(
      (await finance.ruleTests.listTestSets(actor, company.id)).items,
    ).toEqual([]);
    await expect(
      finance.ruleTests.start(
        actor,
        company.id,
        { expected_version: company.version, test_set_id: companySet.id },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      finance.ruleTests.createTestSet(
        other,
        company.id,
        { ...payload, expected_version: company.version },
        key(),
      ),
    ).rejects.toBeTruthy();
    await expect(
      finance.ruleTests.listTestSets(other, company.id),
    ).rejects.toBeTruthy();
  });
  it('五项真实执行使用动态数量，人工预期错误会完成但证明不可启用或发布', async () => {
    const rule = await draft(),
      samples = cases();
    samples[0]!.expected_truth = 'false';
    samples.push({
      name: '一间夜正常',
      input: lodgingInput('79999', '1'),
      expected_truth: 'true',
    });
    const set = await finance.ruleTests.createTestSet(
        actor,
        rule.id,
        {
          expected_version: rule.version,
          name: '含错误预期的五项',
          cases: samples,
        },
        key(),
      ),
      task = await finance.ruleTests.start(
        actor,
        rule.id,
        { expected_version: rule.version, test_set_id: set.id },
        key(),
      );
    while (await finance.processNextJob('manual-wrong-expected')) {}
    const completed = await finance.ruleTests.get(actor, rule.id, task.task_id);
    expect(completed).toMatchObject({
      status: 'completed',
      total_cases: 5,
      completed_cases: 5,
      proof: { passed: false },
    });
    expect(completed.proof!.results).toHaveLength(5);
    expect(completed.proof!.results[0]).toMatchObject({
      expected_truth: 'false',
      truth: 'true',
    });
    const args = {
        rule_id: rule.id,
        expected_version: rule.version,
        draft_hash: set.draft_hash,
        test_run_id: task.test_run_id,
      },
      handlers = createFinanceActionHandlers(finance);
    for (const operation of ['rule.enable', 'rule.publish'] as const)
      await expect(
        handlers[operation]!.validate(
          actor,
          args,
          [{ type: 'rule', id: rule.id, version: rule.version }],
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    await expect(
      database.db.transaction((tx) =>
        finance.rules.activateRule(actor, args, tx),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    expect(await finance.rules.getRule(actor, rule.id)).toMatchObject({
      active_version_id: null,
      draft_version_id: rule.draft_version_id,
      version: rule.version,
    });
  });
  it('SQL不能修改集合内容或绑定，Demo归档写屏障同样覆盖新表', async () => {
    const rule = await draft(),
      set = await finance.ruleTests.createTestSet(
        actor,
        rule.id,
        { expected_version: rule.version, name: '不可变集合', cases: cases() },
        key(),
      );
    for (const [column, value] of [
      ['name', '篡改名称'],
      ['owner_id', other.user_id],
      ['draft_hash', 'changed'],
      ['test_set_hash', 'f'.repeat(64)],
      ['content_hash', 'e'.repeat(64)],
    ])
      await expect(
        database.pool.query(
          `UPDATE rule_test_sets SET ${column}=$3 WHERE tenant_id=$1 AND id=$2`,
          [tenant, set.id, value],
        ),
      ).rejects.toThrow('rule test set is immutable');
    await expect(
      database.pool.query(
        "UPDATE rule_test_sets SET cases_json=jsonb_set(cases_json,'{0,expected_truth}','\"false\"') WHERE tenant_id=$1 AND id=$2",
        [tenant, set.id],
      ),
    ).rejects.toThrow('rule test set is immutable');
    const environment = `manual-fence-${key()}`;
    try {
      await database.pool.query(
        "INSERT INTO demo_environments(id,logical_tenant_id,active_tenant_id,active_generation,lifecycle,seed_version) VALUES($1,$2,$3,2,'ready','finance-agent-v1.0')",
        [environment, `${tenant}-logical`, `${tenant}-current`],
      );
      await database.pool.query(
        "INSERT INTO demo_generation_manifests(env_id,generation,namespace_ref,seed_version,seed_hash,manifest,state) VALUES($1,1,$2,'finance-agent-v1.0','manual-fixture','{}','archived')",
        [environment, tenant],
      );
      await expect(
        database.pool.query(
          'DELETE FROM rule_test_sets WHERE tenant_id=$1 AND id=$2',
          [tenant, set.id],
        ),
      ).rejects.toThrow('DEMO_GENERATION_FENCED');
    } finally {
      await database.pool.query(
        'DELETE FROM demo_generation_manifests WHERE env_id=$1',
        [environment],
      );
      await database.pool.query('DELETE FROM demo_environments WHERE id=$1', [
        environment,
      ]);
    }
    expect(
      (await finance.ruleTests.listTestSets(actor, rule.id)).items[0],
    ).toMatchObject({
      id: set.id,
      name: set.name,
      content_hash: set.content_hash,
      cases: set.cases,
    });
  });
});
