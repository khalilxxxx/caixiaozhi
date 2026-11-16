import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createFileService } from '../../packages/files/src/index.js';
import { createFinanceService } from '../../packages/finance/src/index.js';
import { DocumentService } from '../../packages/business-adapters/src/domain/documents.js';
import {
  getPreauditInput,
  getApprovalTask,
  listCurrentApprovalDocuments,
} from '../../packages/business-adapters/src/domain/projection.js';
import { seedBusiness } from '../../packages/fixtures/src/business.js';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import { personalMealsDsl } from '../../packages/finance/src/rule-seeds.js';
import { StartPreauditSchema } from '@caixiaozhi/contracts/preaudit';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `finance-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'finance-integration-secret-at-least-32-characters',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const files = createFileService(database, storage, { identity });
const documents = new DocumentService(database, {
  identity,
  businessDate: async () => '2026-11-05',
});
for (const kind of ['travel', 'expense_claim', 'oa_request'])
  identity.registerResourceResolver(kind, (ctx, ref) =>
    documents.metadata(ctx, ref),
  );
// 仅隔离测试队列的调度命名空间；真实SQL领取、租约、处理和结果均不替换。
const queue = createDurableQueue(database),
  prefix = `integration:${tenant}:`;
const isolatedQueue: ReturnType<typeof createDurableQueue> = {
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
const finance = createFinanceService(database, {
  identity,
  files,
  jobs: isolatedQueue,
  business: {
    getPreauditInput: (ctx, id, version, tx) =>
      getPreauditInput(documents, ctx, id, version, tx),
    getApprovalTask: (ctx, ref, tx) => getApprovalTask(documents, ctx, ref, tx),
    listCurrentApprovalDocuments: (ctx) =>
      listCurrentApprovalDocuments(documents, ctx),
  },
});
let zhang: ActorContext,
  li: ActorContext,
  liu: ActorContext,
  admin: ActorContext;
const drain = async () => {
  for (
    let i = 0;
    i < 100 && (await finance.processNextJob('finance-integration-worker'));
    i++
  ) {}
};
describe('真实业务快照、制度来源和预审', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    const login = async (id: string) =>
      identity.getActor(
        (
          await identity.loginDemo(id, undefined, {
            tenantId: tenant,
            environmentId: tenant,
            generation: 1,
          })
        ).session_token,
      );
    [zhang, li, liu, admin] = await Promise.all([
      login('u-zhang'),
      login('u-li'),
      login('u-liu'),
      login('u-zhao'),
    ]);
    await seedBusiness({ database, storage, tenantId: tenant });
    await finance.seedDemo(liu);
  }, 30000);
  afterAll(async () => {
    const objects = await database.pool.query(
      'SELECT object_key FROM uploaded_files WHERE tenant_id=$1',
      [tenant],
    );
    for (const row of objects.rows) await storage.deleteObject(row.object_key);
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
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenant],
    );
    await database.pool.query('DELETE FROM uploaded_files WHERE tenant_id=$1', [
      tenant,
    ]);
    storage.close();
    await database.close();
  }, 30000);
  it('中文检索返回真实800元间夜来源，管理员和无依据例外不获正文', async () => {
    const result = await finance.searchAuthorized(li, {
      query: '杭州住宿标准',
      business_date: '2026-11-10',
      top_k: 6,
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.quote.includes('每间夜800元'))).toBe(true);
    const source = await finance.knowledge.getCitation(
      li,
      result.hits[0]!.citation_id,
    );
    expect(source.quote).toBe(
      source.context.slice(source.start_utf16, source.end_utf16),
    );
    expect(
      (
        await finance.searchAuthorized(admin, {
          query: '住宿',
          business_date: '2026-11-10',
          top_k: 6,
        })
      ).hits,
    ).toEqual([]);
    await expect(
      finance.knowledge.getCitation(admin, result.hits[0]!.citation_id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await finance.searchAuthorized(li, {
          query: '超标怎么办例外审批',
          business_date: '2026-11-10',
          top_k: 6,
        })
      ).hits,
    ).toEqual([]);
  });
  it('制度附件读权限不等于维护权限，主管不能通过invoice用途登记或绑定制度附件', async () => {
    const policy = (await finance.knowledge.listPolicies(liu)).items.find(
      (value) => value.id === 'pol-expense',
    );
    const version = policy?.versions.find(
      (value) => value.publication_state === 'published',
    );
    if (!policy || !version) throw new Error('基线制度不存在');
    const parent = {
      type: 'policy' as const,
      id: policy.id,
      version: version.version_no,
    };
    await files.bindParent(liu, version.source_file_id, parent);
    expect(
      (await files.readFile(zhang, version.source_file_id)).bytes.byteLength,
    ).toBeGreaterThan(0);
    const input = {
      filename: '不得写入制度.pdf',
      mime_type: 'application/pdf' as const,
      size_bytes: 100,
      profile: 'invoice-v1' as const,
    };
    await expect(
      files.registerUpload(
        zhang,
        { ...input, parent_ref: parent },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const registered = await files.registerUpload(zhang, input, randomUUID());
    await expect(
      files.bindParent(zhang, registered.file.id, parent),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await files.getFile(zhang, registered.file.id)).parent_ref,
    ).toBeNull();
    const permitted = await files.registerUpload(
      liu,
      {
        filename: '维护者制度.md',
        mime_type: 'text/markdown',
        size_bytes: 100,
        profile: 'policy-text-v1',
        parent_ref: parent,
      },
      randomUUID(),
    );
    expect(permitted.file.parent_ref).toEqual(parent);
  });
  it('五张554000分由真实DSL产生四组，low仅两张124000分', async () => {
    const documents: Array<ResourceRef & { type: 'expense_claim' }> =
      Array.from({ length: 5 }, (_, i) => ({
        type: 'expense_claim',
        id: `clm-${String(i + 1).padStart(3, '0')}`,
        version: 1,
      }));
    const key = randomUUID();
    const accepted = await finance.startPreaudit(
      zhang,
      { purpose: 'manager_review', documents },
      key,
    );
    expect(
      (
        await finance.startPreaudit(
          zhang,
          { purpose: 'manager_review', documents },
          key,
        )
      ).task_id,
    ).toBe(accepted.task_id);
    await drain();
    const task = await finance.getTask(zhang, accepted.task_id);
    expect(task.task.status).toBe('completed');
    expect(task.summary.total_amount.amount_minor).toBe('554000');
    expect(
      Object.fromEntries(
        Object.entries(task.summary.groups).map(([g, v]) => [g, v.count]),
      ),
    ).toEqual({ risk: 1, incomplete: 1, attention: 1, low: 2 });
    const candidates = await finance.preaudit.bulkCandidates(
      zhang,
      task.task.id,
    );
    expect(candidates.total_amount.amount_minor).toBe('124000');
    expect(candidates.items.map((i) => i.document_ref.id)).toEqual([
      'clm-001',
      'clm-005',
    ]);
    const unknown = task.items.find(
      (i) => i.document_ref.id === 'clm-004',
    )!.result!;
    expect(unknown.amount?.amount_minor).toBe('90000');
    expect(unknown.coverage.company_unknown_total).toBe(1);
    expect(unknown.findings[0]?.kind).toBe('unresolved_required');
  });
  it('混入技术部单据整批404且没有任务副作用，员工预检不加载主管个人规则', async () => {
    const before = await database.pool.query(
      'SELECT count(*)::int AS n FROM preaudit_tasks WHERE tenant_id=$1',
      [tenant],
    );
    await expect(
      finance.startPreaudit(
        zhang,
        {
          purpose: 'manager_review',
          documents: [
            { type: 'expense_claim', id: 'clm-001', version: 1 },
            { type: 'expense_claim', id: 'clm-006', version: 1 },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS n FROM preaudit_tasks WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0],
    ).toEqual(before.rows[0]);
    const accepted = await finance.startPreaudit(
      li,
      {
        purpose: 'employee_precheck',
        documents: [{ type: 'expense_claim', id: 'clm-002', version: 1 }],
      },
      randomUUID(),
    );
    await drain();
    const task = await finance.getTask(li, accepted.task_id);
    expect(task.items[0]!.result).toMatchObject({
      group: 'low',
      eligible_for_bulk_approval: false,
    });
    expect(task.items[0]!.result!.locked_versions.personal_rule_refs).toEqual(
      [],
    );
  });
  it('材料变化立即stale，旧候选及人工确认不可复用', async () => {
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-001', version: 1 }],
      },
      randomUUID(),
    );
    await drain();
    const task = await finance.getTask(zhang, accepted.task_id);
    const result = task.items[0]!.result!;
    expect(result.eligible_for_bulk_approval).toBe(true);
    await database.pool.query(
      'UPDATE invoices SET version=version+1 WHERE tenant_id=$1 AND id=$2',
      [tenant, 'inv-001'],
    );
    const fresh = await finance.getResult(zhang, result.result_id);
    expect(fresh.status).toBe('stale');
    expect(fresh.eligible_for_bulk_approval).toBe(false);
    const proof = await finance.preauditEligibility.check(zhang, {
      resource_ref: result.document_ref,
      task_ref: result.task_ref!,
      preaudit_result_id: result.result_id,
      expected_purpose: 'manager_review',
    });
    expect(proof.eligible).toBe(false);
    await expect(
      finance.preaudit.validateManualReview(
        zhang,
        result.document_ref,
        {
          preaudit_result_id: result.result_id,
          result_hash: result.result_hash,
          lock_hash: result.lock_hash,
          acknowledged_finding_ids: [],
        },
        '已复核',
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
  it('未配置模型不会把任意自然语言伪装成固定餐饮规则', async () => {
    const before = await finance.rules.listRules(zhang);
    await expect(
      finance.rules.proposeRule(
        zhang,
        {
          natural_language: '住宿超过未知标准自动批准',
          module: 'expense_claim',
          purpose: 'manager_review',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect((await finance.rules.listRules(zhang)).items.length).toBe(
      before.items.length,
    );
  });
  it('失去同代领域租约的旧Worker不写结果，新租约只完成一次', async () => {
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      randomUUID(),
    );
    const queue = finance.options.jobs!;
    const old = await queue.claim('expired-finance-worker', ['preaudit.item']);
    expect(old?.tenant_id).toBe(tenant);
    if (!old) throw new Error('未领取任务');
    await database.pool.query(
      "UPDATE durable_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    const fresh = await queue.claim('fresh-finance-worker', ['preaudit.item']);
    expect(fresh?.id).toBe(old.id);
    if (!fresh) throw new Error('未恢复租约');
    await expect(finance.handleJob(old)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(
      (await finance.getTask(zhang, accepted.task_id)).items[0]?.result_id,
    ).toBeNull();
    await finance.handleJob(fresh);
    await queue.finish(
      fresh.id,
      'fresh-finance-worker',
      fresh.lease_epoch,
      'succeeded',
    );
    expect(
      (await finance.getTask(zhang, accepted.task_id)).counts.completed,
    ).toBe(1);
  });
  it('手工规则测试绑定草稿与映射，编辑已启用规则时旧版继续参与运行', async () => {
    const initial = await finance.rules.getRule(zhang, 'rule-personal-meals');
    const edited = await finance.rules.saveDraft(
      zhang,
      initial.id,
      initial.version,
      {
        name: initial.name,
        level: 'personal',
        category: 'meals',
        dsl_json: personalMealsDsl(['dept-sales'], '200000'),
        source_citation_ids: [],
        source_kind: 'personal',
      },
      randomUUID(),
    );
    const snapshot = await getPreauditInput(documents, zhang, 'clm-002', 1);
    const before = await finance.rules.resolveRuleSet(
      zhang,
      snapshot.input,
      'manager_review',
      snapshot.input.business_date,
    );
    expect(
      before.personal.some((rule) => rule.version_id === 'rv-personal-meals-1'),
    ).toBe(true);
    const cases = [199999n, 200000n, 200001n, null].map((amount, index) => {
      const input = structuredClone(snapshot.input);
      const value =
        amount === null
          ? null
          : { amount_minor: amount.toString(), currency: 'CNY' as const };
      input.total_amount = value;
      input.expense_items[0]!.amount = value;
      return {
        name: `合成边界${index}`,
        input,
        expected_truth:
          index === 2
            ? ('true' as const)
            : index === 3
              ? ('unknown' as const)
              : ('false' as const),
      };
    });
    const tested = await finance.rules.testRule(
      zhang,
      edited.id,
      edited.version,
      cases,
      randomUUID(),
    );
    expect(tested.passed).toBe(true);
    const draft = edited.versions.find(
      (v: any) => v.id === edited.draft_version_id,
    );
    const next = await finance.rules.saveDraft(
      zhang,
      edited.id,
      edited.version,
      {
        name: edited.name,
        level: 'personal',
        category: 'meals',
        dsl_json: personalMealsDsl(['dept-sales'], '300000'),
        source_citation_ids: [],
        source_kind: 'personal',
      },
      randomUUID(),
    );
    await expect(
      database.db.transaction((tx) =>
        finance.rules.activateRule(
          zhang,
          {
            rule_id: next.id,
            expected_version: next.version,
            draft_hash: draft.content_hash,
            test_run_id: tested.test_run_id,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
  it('部分技术失败保留成功结果，只重试所选失败项；取消保留已完成检查', async () => {
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [
          { type: 'expense_claim', id: 'clm-001', version: 1 },
          { type: 'expense_claim', id: 'clm-005', version: 1 },
        ],
      },
      randomUUID(),
    );
    const original = finance.options.business.getPreauditInput;
    finance.options.business.getPreauditInput = async (
      ctx,
      id,
      version,
      tx,
    ) => {
      if (id === 'clm-005') throw new Error('测试输入读取服务中断');
      return original(ctx, id, version, tx);
    };
    try {
      await drain();
    } finally {
      finance.options.business.getPreauditInput = original;
    }
    const partial = await finance.getTask(zhang, accepted.task_id);
    expect(partial.task.status).toBe('partial_failed');
    expect(partial.counts.completed).toBe(1);
    expect(partial.counts.failed).toBe(1);
    const kept = partial.items.find(
      (item) => item.status === 'completed',
    )!.result_id;
    const failed = partial.items.find((item) => item.status === 'failed')!;
    const retry = await finance.preaudit.retryTask(
      zhang,
      partial.task.id,
      partial.task.version,
      [failed.id],
      randomUUID(),
    );
    await drain();
    expect((await finance.getTask(zhang, retry.task_id)).counts.completed).toBe(
      1,
    );
    expect(
      (await finance.getTask(zhang, partial.task.id)).items.find(
        (item) => item.status === 'completed',
      )!.result_id,
    ).toBe(kept);
    const cancel = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [
          { type: 'expense_claim', id: 'clm-001', version: 1 },
          { type: 'expense_claim', id: 'clm-005', version: 1 },
        ],
      },
      randomUUID(),
    );
    expect(await finance.processNextJob('cancel-finance-worker')).toBe(true);
    const running = await finance.getTask(zhang, cancel.task_id);
    await finance.preaudit.cancelTask(
      zhang,
      cancel.task_id,
      running.task.version,
      randomUUID(),
    );
    await drain();
    const stopped = await finance.getTask(zhang, cancel.task_id);
    expect(stopped.task.status).toBe('cancelled');
    expect(stopped.counts.completed).toBe(1);
    expect(
      stopped.items.filter((item) => item.skipped_reason === 'task_cancelled'),
    ).toHaveLength(1);
  });
  it('知识问答调用真实端口边界、幂等只调用一次，模型只能引用本轮仍授权来源', async () => {
    const runId = randomUUID();
    await database.pool.query(
      "INSERT INTO agent_runs(id,tenant_id,owner_id,origin,thread_id,input_message_id,status,authz_version,actor_context,trace_id,budgets) VALUES($1,$2,$3,'conversation',$4,$5,'succeeded',$6,$7,$8,$9)",
      [
        runId,
        tenant,
        zhang.user_id,
        randomUUID(),
        randomUUID(),
        zhang.authz_version,
        JSON.stringify(zhang),
        randomUUID(),
        JSON.stringify({
          model_calls: 12,
          tool_calls: 30,
          output_tokens: 16000,
          active_ms: 600000,
        }),
      ],
    );
    let calls = 0,
      badCitation = false,
      badUnit = false;
    const modeled = createFinanceService(database, {
      ...finance.options,
      knowledgeModelVersion: 'trusted-config-model-v1',
      answerKnowledge: async (_ctx, { snapshot }) => {
        calls++;
        const lodging = snapshot.hits.find((hit) =>
          hit.quote.includes('每间夜800元'),
        )!;
        return {
          blocks: [
            {
              text: badUnit ? '住宿标准为800元/人/天。' : lodging.quote,
              citation_ids: [
                badCitation ? 'unselected-citation' : lodging.citation_id,
              ],
            },
          ],
          model_version: 'untrusted-self-report',
        };
      },
    });
    const query = { query: '住宿标准', business_date: '2026-11-10', top_k: 6 };
    const key = randomUUID();
    const answer = await modeled.knowledge.question(zhang, query, runId, key);
    expect(answer.answer_state).toBe('answered');
    expect(answer.model_version).toBe('trusted-config-model-v1');
    expect(
      (await modeled.knowledge.question(zhang, query, runId, key)).question_id,
    ).toBe(answer.question_id);
    expect(calls).toBe(1);
    await expect(
      modeled.knowledge.question(li, query, runId, randomUUID()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toBe(1);
    badCitation = true;
    const rejected = await modeled.knowledge.question(
      zhang,
      query,
      runId,
      randomUUID(),
    );
    expect(rejected.answer_state).toBe('degraded');
    expect(rejected.citation_ids).not.toContain('unselected-citation');
    badCitation = false;
    badUnit = true;
    const units = await modeled.knowledge.question(
      zhang,
      query,
      runId,
      randomUUID(),
    );
    expect(units.answer_state).toBe('degraded');
    expect(
      units.answer_blocks.every((block) => !block.text.includes('人/天')),
    ).toBe(true);
    const feedback = await modeled.knowledge.addFeedback(
      zhang,
      {
        answer_id: answer.question_id,
        kind: 'helpful',
        citation_id: answer.citation_ids[0],
      },
      randomUUID(),
    );
    expect(feedback.saved).toBe(true);
    await expect(
      modeled.knowledge.addFeedback(
        li,
        { answer_id: answer.question_id, kind: 'incorrect' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('制度撤回使旧候选stale，新预审保留来源unknown而不返回low', async () => {
    const accepted = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      randomUUID(),
    );
    await drain();
    const result = (await finance.getTask(zhang, accepted.task_id)).items[0]!
      .result!;
    expect(result.group).toBe('low');
    const policies = await finance.knowledge.listPolicies(liu);
    const policy = policies.items.find((p) => p.id === 'pol-expense')!,
      version = policy.versions.find(
        (v) => v.publication_state === 'published',
      )!;
    await database.db.transaction((tx) =>
      finance.knowledge.publishPolicy(
        liu,
        {
          policy_id: policy.id,
          version_id: version.id,
          expected_version: version.version,
          withdraw: true,
        },
        tx,
      ),
    );
    expect((await finance.getResult(zhang, result.result_id)).status).toBe(
      'stale',
    );
    const repeated = await finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
      randomUUID(),
    );
    await drain();
    const rechecked = (await finance.getTask(zhang, repeated.task_id)).items[0]!
      .result!;
    expect(rechecked.group).toBe('incomplete');
    expect(rechecked.coverage.failed_dependencies).toContain(
      'SOURCE_REVIEW_REQUIRED',
    );
  });
});
