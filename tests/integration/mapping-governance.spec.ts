import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import type {
  MappingDraft,
  MappingPublishArgs,
} from '@caixiaozhi/contracts/mappings';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createFileService } from '../../packages/files/src/index.js';
import {
  createFinanceService,
  createFinanceActionHandlers,
} from '../../packages/finance/src/index.js';
import { DocumentService } from '../../packages/business-adapters/src/domain/documents.js';
import {
  getPreauditInput,
  getApprovalTask,
  listCurrentApprovalDocuments,
} from '../../packages/business-adapters/src/domain/projection.js';
import { seedBusiness } from '../../packages/fixtures/src/business.js';
import { createActionService } from '../../packages/action-service/src/index.js';
import {
  providerDocumentFromSnapshot,
  DEFAULT_SRS_MAPPING_FIELDS,
} from '../../packages/finance/src/mappings.js';
import { personalMealsDsl } from '../../packages/finance/src/rule-seeds.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerRuleRoutes } from '../../apps/api/src/modules/rules/routes.js';
import { createIdentityHttpContext } from '../../apps/api/src/modules/identity/routes.js';

const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `mapping-${randomUUID()}`,
  otherTenant = `mapping-other-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'mapping-governance-integration-secret-long-enough',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const files = createFileService(database, storage, { identity }),
  documents = new DocumentService(database, {
    identity,
    businessDate: async () => '2026-11-05',
  });
for (const type of ['travel', 'expense_claim', 'oa_request'])
  identity.registerResourceResolver(type, (ctx, ref) =>
    documents.metadata(ctx, ref),
  );
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
  claim: async (worker, kinds, lease) => {
    const job = await queue.claim(
      worker,
      kinds.map((kind) => `${prefix}${kind}`),
      lease,
    );
    return job ? { ...job, kind: job.kind.slice(prefix.length) } : null;
  },
};
const finance = createFinanceService(database, {
  identity,
  files,
  jobs: isolated,
  business: {
    getPreauditInput: async (ctx, id, version, tx) =>
      finance.mappings.normalizeSnapshot(
        ctx,
        await getPreauditInput(documents, ctx, id, version, tx),
        { provider: 'demo-expenses', source_schema_version: 'expense-v1' },
        tx,
      ),
    getApprovalTask: (ctx, ref, tx) => getApprovalTask(documents, ctx, ref, tx),
    listCurrentApprovalDocuments: (ctx) =>
      listCurrentApprovalDocuments(documents, ctx),
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
let liu: ActorContext,
  zhang: ActorContext,
  li: ActorContext,
  other: ActorContext,
  cookie: string,
  csrf: string,
  liCookie: string,
  mapping: any;
const key = () => randomUUID();
const input = (mode = 'partial', provider = 'demo-expenses'): MappingDraft => ({
  name: '权威单据字段映射',
  department_ids: ['dept-sales'],
  mapping_json: {
    provider,
    source_schema_version: 'expense-v1',
    module: 'expense_claim',
    field_catalog_version: 1,
    fields: DEFAULT_SRS_MAPPING_FIELDS.filter(
      (field) =>
        mode !== 'partial' || field.target_field !== 'invoices[].verified',
    ),
  },
});
async function sample(definition: any, mismatch = false) {
  const raw = await getPreauditInput(documents, zhang, 'clm-005', 1);
  const draft = definition.versions.find(
    (version: any) => version.id === definition.draft_version_id,
  );
  const expected: Array<{ target_field: string; state: string; value: any }> =
    [];
  for (const field of draft.mapping_json.fields) {
    if (field.target_field.includes('[]')) {
      const collection = field.target_field.startsWith('expense_items')
          ? 'expense_items'
          : 'invoices',
        name = field.target_field.split('.')[1] as string;
      for (const row of raw.input[collection]) {
        const path = `${collection}.${row.id}.${name}`,
          value = (row as unknown as Record<string, unknown>)[name];
        expected.push({
          target_field: path,
          state:
            raw.input.field_states[path]?.state ??
            (value === null ? 'missing' : 'known'),
          value,
        });
      }
    } else if (field.target_field === 'external_facts.oa_approved') {
      expected.push({
        target_field: field.target_field,
        state: 'known',
        value: raw.input.external_facts.oa_approved!.value,
      });
    } else if (field.target_field.startsWith('travel.')) {
      expected.push({
        target_field: field.target_field,
        state: 'unavailable',
        value: null,
      });
    } else {
      const value = (raw.input as unknown as Record<string, unknown>)[
        field.target_field
      ];
      expected.push({
        target_field: field.target_field,
        state: value === null ? 'missing' : 'known',
        value,
      });
    }
  }
  if (mismatch) expected[0]!.value = '人工错误预期';
  return {
    expected_version: definition.version,
    cases: [
      {
        name: '规范单据值按人工清单保留，缺映射保持未知',
        source: providerDocumentFromSnapshot(
          raw,
          definition.provider,
          'expense-v1',
        ),
        expected,
      },
    ],
  };
}
function args(definition: any, proof: any): MappingPublishArgs {
  const draft = definition.versions.find(
    (version: any) => version.id === definition.draft_version_id,
  );
  return {
    mapping_id: definition.id,
    expected_version: definition.version,
    draft_id: draft.id,
    draft_hash: draft.content_hash,
    test_run_id: proof.test_run_id,
  };
}
function actions(failAfterPublish = false) {
  const service = createActionService(database.db, {
    signingSecret: 'mapping-action-integration-signing-secret-long-enough',
    freshActor: (a) => identity.requireCurrentActor(a),
    assertResourceAccess: async () => {
      throw new Error('字段映射不能伪装为业务ResourceRef。');
    },
  });
  const handler = createFinanceActionHandlers(finance)['rule.mapping.publish']!;
  service.registerHandler(
    'rule.mapping.publish',
    failAfterPublish
      ? {
          ...handler,
          execute: async (ctx, tx, action) => {
            await handler.execute(ctx, tx, action);
            throw new AppError(
              'DEPENDENCY_UNAVAILABLE',
              '模拟本地事务提交前失败。',
            );
          },
        }
      : handler,
  );
  return service;
}
async function confirm(
  service: ReturnType<typeof actions>,
  publishArgs: MappingPublishArgs,
) {
  const prepared = await service.prepareAction(liu, {
      action: 'rule.mapping.publish',
      resource_refs: [],
      args: publishArgs,
      idempotency_key: key(),
    }),
    review = await service.getReview(liu, prepared.confirmation_id, {
      channel: 'browser',
    });
  return service.confirmAction(liu, prepared.confirmation_id, {
    expected_version: review.version,
    summary_hash: review.summary_hash,
    confirmation_token: review.confirmation_token!,
  });
}
async function drain() {
  for (
    let i = 0;
    i < 30 && (await finance.processNextJob('mapping-integration-worker'));
    i++
  ) {}
}
async function currentRevision() {
  return (
    await database.pool.query(
      "SELECT revision FROM finance_revision_guards WHERE tenant_id=$1 AND id='mapping'",
      [tenant],
    )
  ).rows[0].revision;
}

describe('人工映射治理真实发布、归一化与失效边界', () => {
  beforeAll(async () => {
    for (const id of [tenant, otherTenant])
      await identity.seedDemoIdentity({
        tenantId: id,
        environmentId: id,
        generation: 1,
      });
    const login = async (id: string, t = tenant) => {
      const s = await identity.loginDemo(id, undefined, {
        tenantId: t,
        environmentId: t,
        generation: 1,
      });
      return { actor: await identity.getActor(s.session_token), session: s };
    };
    const a = await login('u-liu'),
      b = await login('u-zhang'),
      c = await login('u-li'),
      d = await login('u-liu', otherTenant);
    liu = a.actor;
    zhang = b.actor;
    li = c.actor;
    other = d.actor;
    cookie = `caixiaozhi_session=${a.session.session_token}`;
    csrf = a.session.csrf_token;
    liCookie = `caixiaozhi_session=${c.session.session_token}`;
    await seedBusiness({ database, storage, tenantId: tenant });
    await finance.seedDemo(liu);
    await app.ready();
  }, 30000);
  afterAll(async () => {
    await app.close();
    const objects = await database.pool.query(
      'SELECT object_key FROM uploaded_files WHERE tenant_id=$1',
      [tenant],
    );
    for (const row of objects.rows) await storage.deleteObject(row.object_key);
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
    for (const table of [
      'oa_budget_reservations',
      'invoice_reservations',
      'expense_items',
      'invoices',
      'approval_decisions',
      'approval_tasks',
      'expense_claims',
      'travel_legs',
      'travel_requests',
      'entertainment_requests',
      'business_snapshots',
      'business_command_ledger',
      'durable_jobs',
      'outbox_events',
      'file_command_ledger',
      'agent_runs',
    ])
      await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
        tenant,
      ]);
    for (const id of [tenant, otherTenant])
      await database.pool.query(
        'DELETE FROM identity_environments WHERE tenant_id=$1',
        [id],
      );
    await database.pool.query('DELETE FROM uploaded_files WHERE tenant_id=$1', [
      tenant,
    ]);
    storage.close();
    await database.close();
  }, 30000);

  it('真实HTTP仅财务在管理组织建草稿，普通人/越界/跨租户读取拒绝', async () => {
    const headers = {
      cookie,
      origin: 'http://localhost',
      'x-csrf-token': csrf,
      'idempotency-key': key(),
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rule-mappings',
      headers,
      payload: input(),
    });
    expect(response.statusCode, response.body).toBe(201);
    mapping = response.json().data;
    const ordinary = await app.inject({
      url: `/api/v1/rule-mappings/${mapping.id}`,
      headers: { cookie: liCookie },
    });
    expect(ordinary.statusCode, ordinary.body).toBe(404);
    await expect(
      finance.mappings.createDraft(li, input('partial', 'ordinary'), key()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      finance.mappings.createDraft(
        liu,
        { ...input('partial', 'outside'), department_ids: ['dept-finance'] },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(finance.mappings.get(other, mapping.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/rule-mappings/${mapping.id}/draft`,
      headers: { ...headers, 'idempotency-key': key() },
      payload: {
        ...input(),
        expected_version: mapping.version,
        script: 'return true',
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('人工样例proof→统一确认发布后真实业务归一化生效，旧预审及规则proof失效', async () => {
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      key(),
    );
    const rule = await finance.rules.createDraft(
      zhang,
      {
        name: '映射变化前的本人规则',
        level: 'personal',
        category: 'meals',
        dsl_json: personalMealsDsl(['dept-sales']),
        source_kind: 'personal',
        source_citation_ids: [],
      },
      key(),
    );
    const ruleTask = await finance.ruleTests.start(
      zhang,
      rule.id,
      { expected_version: rule.version, test_set_id: 'boundary-v1' },
      key(),
    );
    await drain();
    const oldResult = (await finance.getTask(zhang, accepted.task_id)).items[0]!
      .result!;
    expect(oldResult.group).toBe('low');
    const oldProof = (
      await finance.ruleTests.get(zhang, rule.id, ruleTask.task_id)
    ).proof!;
    expect(oldProof.passed).toBe(true);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/rule-mappings/${mapping.id}/tests`,
      headers: {
        cookie,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
        'idempotency-key': key(),
      },
      payload: await sample(mapping),
    });
    expect(response.statusCode, response.body).toBe(200);
    const proof = response.json().data;
    expect(proof.passed).toBe(true);
    const before = await currentRevision(),
      result = await confirm(actions(), args(mapping, proof));
    expect(result.state).toBe('succeeded');
    expect(result.items[0]!.resource_ref).toBeNull();
    expect(result.items[0]!.receipt?.resource).toBeNull();
    expect(await currentRevision()).toBe(before + 1);
    const raw = await getPreauditInput(documents, zhang, 'clm-005', 1),
      normalized = await finance.mappings.normalizeSnapshot(zhang, raw, {
        provider: 'demo-expenses',
        source_schema_version: 'expense-v1',
      });
    expect(raw.input.expense_items[0]!.category).toBe('general');
    expect(normalized.input.expense_items[0]!.category).toBe('general');
    expect(normalized.input.expense_items[0]!.source_expense_type).toBe(
      'office',
    );
    expect(
      normalized.input.field_states[
        `expense_items.${raw.input.expense_items[0]!.id}.category`
      ]?.state,
    ).toBe('known');
    expect(normalized.input.field_states.total_amount?.state).toBe('known');
    expect(
      normalized.input.field_states[
        `invoices.${raw.input.invoices[0]!.id}.verified`
      ]?.state,
    ).toBe('unmapped');
    expect(normalized.provenance.mapping_versions).toEqual([
      { id: mapping.draft_version_id, version: 1 },
    ]);
    const partialTask = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      key(),
    );
    await drain();
    expect(
      (await finance.getTask(zhang, partialTask.task_id)).items[0]!.result!
        .group,
    ).toBe('incomplete');
    expect((await finance.getResult(zhang, oldResult.result_id)).status).toBe(
      'stale',
    );
    expect(
      (await finance.ruleTests.get(zhang, rule.id, ruleTask.task_id)).status,
    ).toBe('stale');
    await expect(
      finance.rules.assertActivationProof(zhang, {
        rule_id: rule.id,
        expected_version: rule.version,
        draft_hash: oldProof.draft_hash,
        test_run_id: oldProof.test_run_id,
      }),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=$1 AND event_type='mapping.changed'",
          [tenant],
        )
      ).rows[0].count,
    ).toBe(1);
    mapping = await finance.mappings.get(liu, mapping.id);
  });

  it('下一版补齐verified映射恢复known和low，同时保持原始财务值', async () => {
    mapping = await finance.mappings.saveDraft(
      liu,
      mapping.id,
      { ...input('complete'), expected_version: mapping.version },
      key(),
    );
    const proof = await finance.mappings.testDraft(
      liu,
      mapping.id,
      await sample(mapping),
      key(),
    );
    expect(proof.passed).toBe(true);
    const version = mapping.draft_version_id,
      before = await currentRevision();
    expect((await confirm(actions(), args(mapping, proof))).state).toBe(
      'succeeded',
    );
    expect(await currentRevision()).toBe(before + 1);
    const raw = await getPreauditInput(documents, zhang, 'clm-005', 1),
      normalized = await finance.mappings.normalizeSnapshot(zhang, raw, {
        provider: 'demo-expenses',
        source_schema_version: 'expense-v1',
      });
    expect(normalized.input.total_amount).toEqual(raw.input.total_amount);
    expect(normalized.input.expense_items).toEqual(raw.input.expense_items);
    expect(normalized.input.invoices).toEqual(raw.input.invoices);
    expect(
      normalized.input.field_states[
        `invoices.${raw.input.invoices[0]!.id}.verified`
      ]?.state,
    ).toBe('known');
    expect(normalized.provenance.mapping_versions).toEqual([
      { id: version, version: 2 },
    ]);
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      key(),
    );
    await drain();
    expect(
      (await finance.getTask(zhang, accepted.task_id)).items[0]!.result!.group,
    ).toBe('low');
    mapping = await finance.mappings.get(liu, mapping.id);
  });

  it('失败样例不得准备发布，未发布新草稿组织和配置不改变active', async () => {
    const active = mapping.active_version_id;
    mapping = await finance.mappings.saveDraft(
      liu,
      mapping.id,
      {
        ...input('complete'),
        department_ids: ['dept-tech'],
        expected_version: mapping.version,
      },
      key(),
    );
    const raw = await getPreauditInput(documents, zhang, 'clm-005', 1),
      unchanged = await finance.mappings.normalizeSnapshot(zhang, raw, {
        provider: 'demo-expenses',
        source_schema_version: 'expense-v1',
      });
    expect(unchanged.input.expense_items[0]!.category).toBe('general');
    expect(
      unchanged.input.field_states[
        `invoices.${raw.input.invoices[0]!.id}.verified`
      ]?.state,
    ).toBe('known');
    mapping = await finance.mappings.saveDraft(
      liu,
      mapping.id,
      { ...input('complete'), expected_version: mapping.version },
      key(),
    );
    const failed = await finance.mappings.testDraft(
      liu,
      mapping.id,
      await sample(mapping, true),
      key(),
    );
    expect(failed.passed).toBe(false);
    await expect(
      actions().prepareAction(liu, {
        action: 'rule.mapping.publish',
        resource_refs: [],
        args: args(mapping, failed),
        idempotency_key: key(),
      }),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    expect(
      (await finance.mappings.get(liu, mapping.id)).active_version_id,
    ).toBe(active);
    await expect(
      finance.mappings.saveDraft(
        liu,
        mapping.id,
        { ...input('complete'), expected_version: 1 },
        key(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('只改名也失效旧样例proof，元数据和published旧版本不能原地改写', async () => {
    const old = mapping,
      proof = await finance.mappings.testDraft(
        liu,
        mapping.id,
        await sample(mapping),
        key(),
      );
    expect(proof.passed).toBe(true);
    mapping = await finance.mappings.saveDraft(
      liu,
      mapping.id,
      {
        ...input('complete'),
        name: '只改变名称的新草稿',
        expected_version: mapping.version,
      },
      key(),
    );
    await expect(
      finance.mappings.preparePublish(liu, args(old, proof)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const newArgs = { ...args(old, proof), expected_version: mapping.version };
    await expect(
      finance.mappings.preparePublish(liu, newArgs),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    await expect(
      database.pool.query(
        'UPDATE field_mapping_versions SET content_hash=$3 WHERE tenant_id=$1 AND id=$2',
        [tenant, mapping.active_version_id, 'forged'],
      ),
    ).rejects.toThrow('mapping version and sample proof are immutable');
    await expect(
      database.pool.query(
        'UPDATE field_mapping_drafts SET name=$3 WHERE tenant_id=$1 AND id=$2',
        [tenant, mapping.draft_version_id, 'forged'],
      ),
    ).rejects.toThrow('mapping version and sample proof are immutable');
  });

  it('统一动作执行事务失败会回滚version/current/revision/outbox', async () => {
    const proof = await finance.mappings.testDraft(
        liu,
        mapping.id,
        await sample(mapping),
        key(),
      ),
      before = await currentRevision(),
      active = mapping.active_version_id;
    const result = await confirm(actions(true), args(mapping, proof));
    expect(result.state).toBe('failed');
    expect(
      (await finance.mappings.get(liu, mapping.id)).active_version_id,
    ).toBe(active);
    expect(await currentRevision()).toBe(before);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS count FROM field_mapping_versions WHERE tenant_id=$1 AND id=$2',
          [tenant, mapping.draft_version_id],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=$1 AND event_type='mapping.changed'",
          [tenant],
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it('准备后草稿发生CAS变化，统一确认拒绝且不改current/revision', async () => {
    const proof = await finance.mappings.testDraft(
        liu,
        mapping.id,
        await sample(mapping),
        key(),
      ),
      service = actions(),
      before = await currentRevision(),
      active = mapping.active_version_id;
    const prepared = await service.prepareAction(liu, {
        action: 'rule.mapping.publish',
        resource_refs: [],
        args: args(mapping, proof),
        idempotency_key: key(),
      }),
      review = await service.getReview(liu, prepared.confirmation_id, {
        channel: 'browser',
      });
    mapping = await finance.mappings.saveDraft(
      liu,
      mapping.id,
      {
        ...input('complete'),
        name: '确认前被更新的新版本',
        expected_version: mapping.version,
      },
      key(),
    );
    const result = await service.confirmAction(liu, prepared.confirmation_id, {
      expected_version: review.version,
      summary_hash: review.summary_hash,
      confirmation_token: review.confirmation_token!,
    });
    expect(result.state).toBe('rejected');
    expect(
      (await finance.mappings.get(liu, mapping.id)).active_version_id,
    ).toBe(active);
    expect(await currentRevision()).toBe(before);
  });

  it('未注册外部来源可验证固定转换，但不能冒充当前业务已生效', async () => {
    const external = await finance.mappings.createDraft(
      liu,
      {
        name: '外部来源样例配置',
        department_ids: ['dept-sales'],
        mapping_json: {
          provider: 'external-manual',
          source_schema_version: 'external-v1',
          module: 'expense_claim',
          field_catalog_version: 1,
          fields: [
            {
              target_field: 'total_amount',
              source_pointer: '/gross',
              transform: 'decimal_yuan_to_minor',
            },
          ],
        },
      },
      key(),
    );
    expect(external.runtime_binding).toBe('sample_only');
    const raw = await getPreauditInput(documents, zhang, 'clm-005', 1),
      proof = await finance.mappings.testDraft(
        liu,
        external.id,
        {
          expected_version: external.version,
          cases: [
            {
              name: '人工1000.01元预期100001分',
              source: {
                provider: 'external-manual',
                source_schema_version: 'external-v1',
                snapshot: raw,
                data: { gross: '1000.01' },
              },
              expected: [
                {
                  target_field: 'total_amount',
                  state: 'known',
                  value: { amount_minor: '100001', currency: 'CNY' },
                },
              ],
            },
          ],
        },
        key(),
      );
    expect(proof.passed).toBe(true);
    const domain = await finance.mappings.preparePublish(
      liu,
      args(external, proof),
    );
    expect(domain.summary.runtime_binding).toBe('sample_only');
    expect(domain.summary.impact).toContain('不改变现行业务输入');
    expect((await confirm(actions(), args(external, proof))).state).toBe(
      'succeeded',
    );
    expect(
      await finance.mappings.normalizeSnapshot(zhang, raw, {
        provider: 'external-manual',
        source_schema_version: 'external-v1',
      }),
    ).toEqual(raw);
  });

  it('授权版本变化或撤去组织后不能复用旧样例proof或重放已缓存正文', async () => {
    const request = await sample(mapping),
      proofKey = key();
    const proof = await finance.mappings.testDraft(
      liu,
      mapping.id,
      request,
      proofKey,
    );
    await database.pool.query(
      'UPDATE identities SET authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
      [tenant, liu.user_id],
    );
    const session = await identity.loginDemo('u-liu', undefined, {
        tenantId: tenant,
        environmentId: tenant,
        generation: 1,
      }),
      fresh = await identity.getActor(session.session_token);
    await expect(
      finance.mappings.preparePublish(fresh, args(mapping, proof)),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    await database.pool.query(
      "UPDATE grants SET scope_ids='[\"dept-tech\"]'::jsonb WHERE tenant_id=$1 AND subject_id=$2 AND capability='rule.manage.company'",
      [tenant, liu.user_id],
    );
    await database.pool.query(
      'UPDATE identities SET authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
      [tenant, liu.user_id],
    );
    const revokedSession = await identity.loginDemo('u-liu', undefined, {
        tenantId: tenant,
        environmentId: tenant,
        generation: 1,
      }),
      revoked = await identity.getActor(revokedSession.session_token);
    await expect(
      finance.mappings.get(revoked, mapping.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      finance.mappings.testDraft(revoked, mapping.id, request, proofKey),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
