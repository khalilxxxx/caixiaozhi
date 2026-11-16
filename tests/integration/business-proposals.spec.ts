import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createFileService } from '../../packages/files/src/index.js';
import {
  DocumentService,
  type BusinessOptions,
} from '../../packages/business-adapters/src/domain/documents.js';
import { InvoiceService } from '../../packages/business-adapters/src/domain/invoices.js';
import { TravelProposalService } from '../../packages/business-adapters/src/domain/proposals.js';
import { ExpenseProposalService } from '../../packages/business-adapters/src/domain/expense-proposals.js';
import {
  seedBusiness,
  makeSyntheticInvoice,
} from '../../packages/fixtures/src/business.js';
import {
  TravelDraftSchema,
  type TravelLeg,
  type TravelOperation,
} from '@caixiaozhi/contracts/travel';
import {
  ExpenseDraftSchema,
  ExpenseProposalModelSchema,
  type ExpenseItem,
  type InvoiceFields,
} from '@caixiaozhi/contracts/expenses';
import type { ActorContext } from '@caixiaozhi/contracts/common';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `proposals-${randomUUID()}`,
  prefix = `integration:${tenant}:`;
const identity = createIdentityService(database, {
    sessionSecret: 'proposals-test-session-secret-at-least-32-characters',
    appMode: 'demo',
    demoAccessEnabled: true,
  }),
  files = createFileService(database, storage, { identity }),
  queue = createDurableQueue(database);
let travelModel: NonNullable<BusinessOptions['proposeTravel']> = async () => {
    throw new Error('未设置本例模型网络替身');
  },
  expenseModel: NonNullable<BusinessOptions['proposeExpense']> = async () => {
    throw new Error('未设置本例模型网络替身');
  };
const documents = new DocumentService(database, {
  identity,
  businessDate: async () => '2026-11-05',
  bindInvoiceFile: (ctx, id, parent, tx) =>
    files.bindParent(ctx, id, parent, tx),
  enqueueDomainJob: async (tx, input) =>
    queue.enqueueInTransaction(tx, {
      ...input,
      kind: `${prefix}${input.kind}`,
    }),
  proposeTravel: (input) => travelModel(input),
  proposeExpense: (input) => expenseModel(input),
});
for (const kind of ['travel', 'expense_claim', 'oa_request'])
  identity.registerResourceResolver(kind, (ctx, ref) =>
    documents.metadata(ctx, ref),
  );
const invoices = new InvoiceService(
    documents,
    files,
    'invoice-test-fingerprint-secret',
    'demo',
  ),
  travel = new TravelProposalService(documents),
  expenses = new ExpenseProposalService(documents, invoices);
let li: ActorContext, wang: ActorContext, zhang: ActorContext;
async function process(kind: 'travel.proposal' | 'expense.proposal') {
  const raw = await queue.claim('proposal-test-worker', [`${prefix}${kind}`]);
  if (!raw) throw new Error('真实队列没有待处理提议');
  const job = { ...raw, kind };
  try {
    if (kind === 'travel.proposal') await travel.processJob(job);
    else await expenses.processJob(job);
    await queue.finish(
      job.id,
      'proposal-test-worker',
      job.lease_epoch,
      'succeeded',
    );
  } catch (error) {
    await queue.finish(
      job.id,
      'proposal-test-worker',
      job.lease_epoch,
      'failed',
      'VALIDATION_ERROR',
    );
    throw error;
  }
}
const leg = (
  key: string,
  from = 'city-beijing',
  to = 'city-hangzhou',
): TravelLeg => ({
  leg_id: key,
  ordinal: 1,
  from_city_id: from,
  to_city_id: to,
  from_place_text: from === 'city-beijing' ? '北京' : '杭州',
  to_place_text: to === 'city-shanghai' ? '上海' : '杭州',
  departure_date: '2026-11-10',
  end_date: '2026-11-10',
  transport_mode: 'train',
  transport_budget: { amount_minor: '10000', currency: 'CNY' },
  lodging_required: false,
  check_in: null,
  check_out: null,
  room_count: null,
  nightly_room_budget: null,
  other_budget: { amount_minor: '0', currency: 'CNY' },
  other_reason: '',
});
const draft = (value: Record<string, unknown>) =>
  TravelDraftSchema.parse(
    Object.fromEntries(
      Object.keys(TravelDraftSchema.shape).map((field) => [
        field,
        value[field],
      ]),
    ),
  );
async function manualInvoice(
  number: string,
  amount: string,
  type: 'transport' | 'meals',
  spent: string,
) {
  const bytes = await makeSyntheticInvoice(number, amount),
    registered = await files.registerUpload(
      li,
      {
        filename: `${number}.pdf`,
        mime_type: 'application/pdf',
        size_bytes: bytes.length,
        profile: 'invoice-v1',
      },
      randomUUID(),
    ),
    uploaded = await files.upload(li, registered.file.id, bytes, {
      uploadToken: registered.upload_target.headers['x-upload-token'],
      expectedVersion: 1,
    });
  const validated = await files.finalizeUpload(
    li,
    registered.file.id,
    {
      expected_version: uploaded.version,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    randomUUID(),
  );
  const invoice = await invoices.createManual(
    li,
    { file_id: validated.id, file_version: validated.version },
    randomUUID(),
  );
  const fields: InvoiceFields = {
    invoice_number: number,
    invoice_code: null,
    invoice_date: spent,
    seller_name: '合成服务商',
    buyer_name: '演示公司',
    seller_tax_id: null,
    buyer_tax_id: null,
    gross_amount: { amount_minor: amount, currency: 'CNY' },
    tax_amount: { amount_minor: '0', currency: 'CNY' },
    net_amount: { amount_minor: amount, currency: 'CNY' },
    invoice_kind: type === 'transport' ? 'transport_ticket' : 'other',
    expense_type: type,
  };
  await invoices.confirm(
    li,
    invoice.id,
    {
      expected_version: 1,
      fields,
      expense_type: type,
      expense_subtype: type === 'meals' ? 'business_entertainment' : null,
    },
    randomUUID(),
  );
  return invoices.get(li, invoice.id);
}
describe('旅行和报销差异提议与独立票面矫正', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    const login = async (user: string) =>
      identity.getActor(
        (
          await identity.loginDemo(user, undefined, {
            tenantId: tenant,
            environmentId: tenant,
            generation: 1,
          })
        ).session_token,
      );
    [li, wang, zhang] = await Promise.all([
      login('u-li'),
      login('u-wang'),
      login('u-zhang'),
    ]);
    await seedBusiness({ database, storage, tenantId: tenant });
  }, 30000);
  afterAll(async () => {
    const objects = await database.pool.query(
      'SELECT object_key FROM uploaded_files WHERE tenant_id=$1',
      [tenant],
    );
    for (const row of objects.rows) await storage.deleteObject(row.object_key);
    for (const table of [
      'expense_proposals',
      'expense_proposal_tasks',
      'travel_proposals',
      'travel_proposal_tasks',
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
  it('空差旅通过明确选择新增行程和头字段，服务端分配永久legID', async () => {
    const created = await documents.create(
      li,
      'travel',
      { title: '空草稿填单' },
      randomUUID(),
    );
    travelModel = async (input) => {
      expect(input.document.version).toBe(1);
      return {
        operations: [
          {
            id: 'head-purpose',
            kind: 'replace',
            leg_id: null,
            field: 'purpose',
            old: '',
            new: '客户沟通',
            evidence_refs: [],
          },
          {
            id: 'head-center',
            kind: 'replace',
            leg_id: null,
            field: 'cost_center_id',
            old: null,
            new: 'cc-sales',
            evidence_refs: [],
          },
          {
            id: 'insert-first',
            kind: 'insert_leg',
            temporary_leg_key: 'first',
            after_leg_id: null,
            leg: leg('model-chosen-id'),
            evidence_refs: [],
          },
          {
            id: 'insert-second',
            kind: 'insert_leg',
            temporary_leg_key: 'second',
            after_leg_id: 'first',
            leg: leg('another-model-id', 'city-hangzhou', 'city-shanghai'),
            evidence_refs: [],
          },
        ],
        clarifications: [],
      };
    };
    const accepted = await travel.create(
      li,
      created.id,
      {
        expected_version: 1,
        prompt: '按本轮明确行程填写',
        selected_material_refs: [],
      },
      randomUUID(),
    );
    await process('travel.proposal');
    const proposal = await travel.get(li, created.id, accepted.proposal_id);
    expect(proposal.status).toBe('proposed');
    const saved = await travel.apply(
      li,
      created.id,
      accepted.proposal_id,
      {
        expected_version: 1,
        selected_operation_ids: proposal.operations.map(
          (operation: TravelOperation) => operation.id,
        ),
      },
      randomUUID(),
    );
    const legs = saved.legs;
    expect(legs).toHaveLength(2);
    expect(legs.every((value) => /^[a-f0-9-]{36}$/.test(value.leg_id))).toBe(
      true,
    );
    expect(legs.map((value) => value.leg_id)).not.toContain('model-chosen-id');
    expect(saved.total_budget).toEqual({
      amount_minor: '20000',
      currency: 'CNY',
    });
  });
  it('重排和删除不改变保留行程ID，旧聚合建议不覆盖手工新值', async () => {
    const created = await documents.create(li, 'travel', {}, randomUUID());
    const saved = await documents.saveTravel(
      li,
      created.id,
      {
        title: '重排行程',
        purpose: '测试稳定ID',
        cost_center_id: 'cc-sales',
        project_id: null,
        material_refs: [],
        legs: [
          leg('new:a'),
          { ...leg('new:b', 'city-hangzhou', 'city-shanghai'), ordinal: 2 },
        ],
        expected_version: 1,
      },
      randomUUID(),
    );
    const source = draft(saved),
      [a, b] = source.legs;
    travelModel = async () => ({
      operations: [
        {
          id: 'reorder',
          kind: 'reorder_legs',
          old: source.legs.map((value) => value.leg_id),
          new: [b!.leg_id, a!.leg_id],
          evidence_refs: [],
        },
        {
          id: 'delete',
          kind: 'delete_leg',
          leg_id: a!.leg_id,
          old: a!,
          evidence_refs: [],
        },
      ],
      clarifications: [],
    });
    const accepted = await travel.create(
      li,
      created.id,
      {
        expected_version: saved.version,
        prompt: '按明确选择重排并删除',
        selected_material_refs: [],
      },
      randomUUID(),
    );
    await process('travel.proposal');
    const applied = await travel.apply(
      li,
      created.id,
      accepted.proposal_id,
      {
        expected_version: saved.version,
        selected_operation_ids: ['reorder', 'delete'],
      },
      randomUUID(),
    );
    expect(applied.legs[0]!.leg_id).toBe(b!.leg_id);
    travelModel = async (input) => ({
      operations: [
        {
          id: 'purpose',
          kind: 'replace',
          leg_id: null,
          field: 'purpose',
          old: input.document.purpose,
          new: '模型候选事由',
          evidence_refs: [],
        },
      ],
      clarifications: [],
    });
    const stale = await travel.create(
      li,
      created.id,
      {
        expected_version: applied.version,
        prompt: '更新事由',
        selected_material_refs: [],
      },
      randomUUID(),
    );
    await process('travel.proposal');
    const manual = await documents.saveTravel(
      li,
      created.id,
      {
        ...draft(applied),
        purpose: '保留手工新事由',
        expected_version: applied.version,
      },
      randomUUID(),
    );
    await expect(
      travel.apply(
        li,
        created.id,
        stale.proposal_id,
        {
          expected_version: applied.version,
          selected_operation_ids: ['purpose'],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await documents.get(li, 'travel', created.id)).purpose).toBe(
      manual.purpose,
    );
  });
  it('报销只采纳本轮两张明确票据，真实绑定两行38000分且不占OA提交额度', async () => {
    const transport = await manualInvoice(
        'DEMO-PROP-TR-9001',
        '18000',
        'transport',
        '2026-11-03',
      ),
      meals = await manualInvoice(
        'DEMO-PROP-ME-9002',
        '20000',
        'meals',
        '2026-11-04',
      );
    const created = await documents.create(
      li,
      'expense_claim',
      { title: '两票提议测试' },
      randomUUID(),
    );
    const item = (
      invoice: typeof transport,
      type: 'transport' | 'meals',
    ): ExpenseItem => ({
      item_id: 'ignored-model-id',
      invoice_id: invoice.id,
      invoice_version: invoice.version,
      expense_type: type,
      expense_subtype: type === 'meals' ? 'business_entertainment' : null,
      type_confirmation: 'confirmed',
      incurred_date: invoice.fields.invoice_date!,
      claim_amount: invoice.fields.gross_amount!,
      reduction_reason: null,
      travel_ref: null,
      oa_ref:
        type === 'meals'
          ? { type: 'oa_request', id: 'oa-001', version: 1 }
          : null,
      lodging_details: null,
      transport_details: null,
    });
    expenseModel = async (input) => {
      expect(input.invoice_snapshots).toHaveLength(2);
      return {
        operations: [
          {
            id: 'center',
            kind: 'replace_claim',
            field: 'cost_center_id',
            old: null,
            new: 'cc-sales',
            evidence_refs: [],
          },
          {
            id: 'purpose',
            kind: 'replace_claim',
            field: 'purpose',
            old: '',
            new: '交通与招待费用',
            evidence_refs: [],
          },
          {
            id: 'transport',
            kind: 'insert_item',
            temporary_item_key: 'transport',
            after_item_id: null,
            item: item(transport, 'transport'),
            evidence_refs: [`${transport.id}@${transport.version}`],
          },
          {
            id: 'meals',
            kind: 'insert_item',
            temporary_item_key: 'meals',
            after_item_id: 'transport',
            item: item(meals, 'meals'),
            evidence_refs: [`${meals.id}@${meals.version}`],
          },
        ],
        clarifications: [],
      };
    };
    const accepted = await expenses.create(
      li,
      created.id,
      {
        expected_version: 1,
        prompt: '将明确选中的两票整理为草稿',
        selected_material_refs: [],
        invoice_refs: [
          { id: transport.id, version: transport.version },
          { id: meals.id, version: meals.version },
        ],
      },
      randomUUID(),
    );
    await process('expense.proposal');
    const candidate = await expenses.get(li, created.id, accepted.proposal_id);
    expect(candidate.status).toBe('proposed');
    const saved = await expenses.apply(
      li,
      created.id,
      accepted.proposal_id,
      {
        expected_version: 1,
        selected_operation_ids: ['center', 'purpose', 'transport', 'meals'],
      },
      randomUUID(),
    );
    expect(saved.total_amount).toEqual({
      amount_minor: '38000',
      currency: 'CNY',
    });
    expect(saved.items).toHaveLength(2);
    expect(
      saved.items.every((value) => value.item_id !== 'ignored-model-id'),
    ).toBe(true);
    const oa = await documents.get(li, 'oa_request', 'oa-001');
    expect(oa.budget_usage.reserved.amount_minor).toBe('120000');
    const before = saved.version;
    const corrected = await invoices.patch(
      li,
      transport.id,
      {
        expected_version: transport.version,
        corrections: { seller_name: '人工核对后修正商户' },
        reason: '对照原件修正',
      },
      randomUUID(),
    );
    expect(corrected.confirmation_state).toBe('needs_confirmation');
    expect(corrected.verification_state).toBe('pending');
    expect((await documents.get(li, 'expense_claim', created.id)).version).toBe(
      before + 1,
    );
  });
  it('报销旧提议不能覆盖手改，模型不能改状态或原票面', async () => {
    expect(
      ExpenseProposalModelSchema.safeParse({
        operations: [
          {
            id: 'bad',
            kind: 'replace_claim',
            field: 'state',
            old: 'draft',
            new: 'completed',
            evidence_refs: [],
          },
        ],
        clarifications: [],
      }).success,
    ).toBe(false);
    expect(
      ExpenseProposalModelSchema.safeParse({
        operations: [
          {
            id: 'bad',
            kind: 'replace_item',
            item_id: 'item',
            field: 'invoice.gross_amount',
            old: null,
            new: { amount_minor: '1', currency: 'CNY' },
            evidence_refs: [],
          },
        ],
        clarifications: [],
      }).success,
    ).toBe(false);
    const created = await documents.create(
      li,
      'expense_claim',
      {},
      randomUUID(),
    );
    expenseModel = async () => ({
      operations: [
        {
          id: 'purpose',
          kind: 'replace_claim',
          field: 'purpose',
          old: '',
          new: '候选事由',
          evidence_refs: [],
        },
      ],
      clarifications: [],
    });
    const accepted = await expenses.create(
      li,
      created.id,
      {
        expected_version: 1,
        prompt: '只修改事由',
        selected_material_refs: [],
        invoice_refs: [],
      },
      randomUUID(),
    );
    await process('expense.proposal');
    const raw = ExpenseDraftSchema.parse({
      title: created.title,
      purpose: '手工新值',
      cost_center_id: null,
      items: [],
      material_refs: [],
    });
    await documents.saveExpense(
      li,
      created.id,
      { ...raw, expected_version: 1 },
      randomUUID(),
    );
    await expect(
      expenses.apply(
        li,
        created.id,
        accepted.proposal_id,
        { expected_version: 1, selected_operation_ids: ['purpose'] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await documents.get(li, 'expense_claim', created.id)).purpose).toBe(
      '手工新值',
    );
  });
  it('审批中的票面不能PATCH，非所有人不能通过部门读权矫正', async () => {
    const before = await invoices.get(wang, 'inv-001');
    await expect(
      invoices.patch(
        wang,
        'inv-001',
        {
          expected_version: before.version,
          corrections: { seller_name: '非法审批中修改' },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      invoices.patch(
        zhang,
        'inv-001',
        {
          expected_version: before.version,
          corrections: { seller_name: '主管替员工修改' },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await invoices.get(wang, 'inv-001')).version).toBe(before.version);
  });
});
