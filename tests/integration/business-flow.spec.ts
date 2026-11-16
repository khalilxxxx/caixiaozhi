import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createIdentityService } from '@caixiaozhi/identity';
import { createActionService } from '@caixiaozhi/action-service';
import { DocumentService } from '@caixiaozhi/business-adapters/domain/documents';
import { ApprovalService } from '@caixiaozhi/business-adapters/domain/approvals';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import type { ActionName } from '@caixiaozhi/contracts/actions';

const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  tenant = `business-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'business-integration-secret-'.repeat(3),
  appMode: 'demo',
  demoAccessEnabled: true,
});
const documents = new DocumentService(database, {
    identity,
    businessDate: async () => '2026-11-05',
  }),
  approvals = new ApprovalService(documents);
for (const kind of ['travel', 'expense_claim', 'oa_request'])
  identity.registerResourceResolver(kind, (actor, ref) =>
    documents.metadata(actor, ref),
  );
const actions = createActionService(database.db, {
  signingSecret: 'business-action-secret-'.repeat(3),
  freshActor: (actor) => identity.requireCurrentActor(actor),
  assertResourceAccess: (actor, operation, ref) =>
    identity.assertResourceAccess(
      actor,
      operation.startsWith('approval.') ? 'approval.decide' : operation,
      ref,
    ),
});
for (const name of [
  'travel.submit',
  'travel.resubmit',
  'travel.withdraw',
  'oa.submit',
  'oa.resubmit',
  'oa.withdraw',
  'expense.submit',
  'expense.resubmit',
  'expense.withdraw',
  'approval.approve',
  'approval.return',
] as ActionName[])
  actions.registerHandler(name, approvals.handler(name));
let li: ActorContext,
  zhang: ActorContext,
  chen: ActorContext,
  admin: ActorContext;
async function run(
  actor: ActorContext,
  operation: ActionName,
  ref: ResourceRef,
  args: unknown = {},
) {
  const intent = await actions.prepareAction(actor, {
    action: operation,
    resource_refs: [ref],
    args,
    idempotency_key: randomUUID(),
  });
  const review = await actions.getReview(actor, intent.confirmation_id, {
    channel: 'browser',
  });
  return actions.confirmAction(actor, intent.confirmation_id, {
    expected_version: review.version,
    summary_hash: review.summary_hash,
    confirmation_token: review.confirmation_token!,
  });
}
const draft = {
  title: '真实差旅测试',
  purpose: '客户会议',
  cost_center_id: 'cc-sales',
  project_id: null,
  material_refs: [],
  legs: [
    {
      leg_id: 'new:first',
      ordinal: 1,
      from_city_id: 'city-beijing',
      to_city_id: 'city-hangzhou',
      from_place_text: '北京',
      to_place_text: '杭州',
      departure_date: '2026-11-10',
      end_date: '2026-11-12',
      transport_mode: 'train',
      transport_budget: { amount_minor: '0', currency: 'CNY' },
      lodging_required: false,
      check_in: null,
      check_out: null,
      room_count: null,
      nightly_room_budget: null,
      other_budget: { amount_minor: '0', currency: 'CNY' },
      other_reason: '',
    },
  ],
};
describe('真实业务草稿、权限、提交与审批', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: `env-${tenant}`,
      generation: 1,
    });
    const actor = async (id: string) =>
      identity.getActor(
        (
          await identity.loginDemo(id, undefined, {
            tenantId: tenant,
            environmentId: `env-${tenant}`,
            generation: 1,
          })
        ).session_token,
      );
    [li, zhang, chen, admin] = await Promise.all([
      actor('u-li'),
      actor('u-zhang'),
      actor('u-chen'),
      actor('u-zhao'),
    ]);
  });
  afterAll(async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const table of [
        'business_receipts',
        'approval_decisions',
        'approval_tasks',
        'travel_proposals',
        'travel_proposal_tasks',
        'travel_legs',
        'travel_requests',
        'entertainment_requests',
        'business_snapshots',
        'business_command_ledger',
        'outbox_events',
        'action_attempts',
        'action_receipts',
        'action_audit',
        'action_items',
        'actions',
        'confirmations',
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
      await client.query(
        'DELETE FROM identity_environments WHERE tenant_id=$1',
        [tenant],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await database.close();
    }
  });
  it('草稿创建幂等，金额服务端求和，腿ID由服务端分配', async () => {
    const key = randomUUID(),
      first = await documents.create(li, 'travel', { title: '幂等草稿' }, key),
      again = await documents.create(li, 'travel', { title: '幂等草稿' }, key);
    expect(again.id).toBe(first.id);
    await expect(
      documents.create(li, 'travel', { title: '不同内容' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const saved = await documents.saveTravel(
      li,
      first.id,
      { ...draft, expected_version: 1 },
      randomUUID(),
    );
    expect(saved.version).toBe(2);
    expect((saved as { total_budget?: unknown }).total_budget).toEqual({
      amount_minor: '0',
      currency: 'CNY',
    });
    expect(
      (saved as { legs?: Array<{ leg_id: string }> }).legs?.[0]?.leg_id,
    ).not.toBe('new:first');
  });
  it('旧版本无法覆盖手工新版本，技术部门及平台管理员不可读销售草稿', async () => {
    const created = await documents.create(li, 'travel', {}, randomUUID());
    await documents.saveTravel(
      li,
      created.id,
      { ...draft, expected_version: 1 },
      randomUUID(),
    );
    await expect(
      documents.saveTravel(
        li,
        created.id,
        { ...draft, title: '旧值', expected_version: 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      documents.get(chen, 'travel', created.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      documents.get(admin, 'travel', created.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await documents.get(li, 'travel', created.id)).title).toBe(
      draft.title,
    );
  });
  it('统一确认真实提交、同ID主管批准，单据与任务一致', async () => {
    const created = await documents.create(li, 'travel', {}, randomUUID());
    const saved = await documents.saveTravel(
      li,
      created.id,
      { ...draft, expected_version: 1 },
      randomUUID(),
    );
    const submitted = await run(li, 'travel.submit', {
      type: 'travel',
      id: created.id,
      version: saved.version,
    });
    expect(submitted.items[0]?.receipt?.outcome).toBe('succeeded');
    const pending = await documents.get(li, 'travel', created.id);
    expect(pending.state).toBe('pending_manager');
    const task = await approvals.currentTask(database.db, zhang, {
      type: 'travel',
      id: created.id,
      version: pending.version,
    });
    const approved = await run(
      zhang,
      'approval.approve',
      { type: 'travel', id: created.id, version: pending.version },
      {
        task_ref: { id: task.id, version: task.version },
        reason: '已核对行程。',
      },
    );
    expect(approved.items[0]?.receipt?.outcome).toBe('succeeded');
    expect((await documents.get(li, 'travel', created.id)).state).toBe(
      'approved',
    );
    await expect(
      documents.saveTravel(
        li,
        created.id,
        { ...draft, expected_version: pending.version + 1 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('撤回与批准竞争只产生一个业务终态和一项成功回执', async () => {
    const created = await documents.create(li, 'travel', {}, randomUUID());
    const saved = await documents.saveTravel(
      li,
      created.id,
      { ...draft, expected_version: 1 },
      randomUUID(),
    );
    await run(li, 'travel.submit', {
      type: 'travel',
      id: created.id,
      version: saved.version,
    });
    const document = await documents.get(li, 'travel', created.id),
      ref = {
        type: 'travel' as const,
        id: document.id,
        version: document.version,
      };
    const task = await approvals.currentTask(database.db, zhang, ref);
    const prepare = async (
      actor: ActorContext,
      name: ActionName,
      args: unknown,
    ) => {
      const intent = await actions.prepareAction(actor, {
        action: name,
        resource_refs: [ref],
        args,
        idempotency_key: randomUUID(),
      });
      const review = await actions.getReview(actor, intent.confirmation_id, {
        channel: 'browser',
      });
      return () =>
        actions.confirmAction(actor, intent.confirmation_id, {
          expected_version: review.version,
          summary_hash: review.summary_hash,
          confirmation_token: review.confirmation_token!,
        });
    };
    const [withdraw, approve] = await Promise.all([
      prepare(li, 'travel.withdraw', {}),
      prepare(zhang, 'approval.approve', {
        task_ref: { id: task.id, version: task.version },
        reason: '核对完成',
      }),
    ]);
    const results = await Promise.allSettled([withdraw(), approve()]);
    expect(
      results
        .flatMap((item) =>
          item.status === 'fulfilled' ? item.value.items : [],
        )
        .filter((item) => item.receipt?.outcome === 'succeeded'),
    ).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(['INVALID_STATE', 'VERSION_CONFLICT']).toContain(
          result.reason.code,
        );
    expect(['approved', 'withdrawn']).toContain(
      (await documents.get(li, 'travel', created.id)).state,
    );
    const active = await database.pool.query(
      'SELECT count(*)::int AS count FROM approval_tasks WHERE tenant_id=$1 AND resource_id=$2 AND state=$3',
      [tenant, created.id, 'pending'],
    );
    expect(active.rows[0]?.count).toBe(0);
  });
});
