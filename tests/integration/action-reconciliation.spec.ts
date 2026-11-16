import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
} from '@caixiaozhi/contracts';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createActionService } from '../../packages/action-service/src/index.js';
import type { ActionHandler } from '@caixiaozhi/business-adapters/ports';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createReceiptReconciler } from '../../apps/worker/src/reconciler/index.js';
const database = createDatabase(loadConfig().databaseUrl),
  tenant = `reconcile-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'reconciliation-real-identity-test-secret-long-enough',
  appMode: 'demo',
  demoAccessEnabled: true,
});
let actor: ActorContext,
  admin: ActorContext,
  generation = 1;
let queryHook: (id: string) => Promise<void> = async () => {};
const receipt = (
  ctx: { action_id: string; idempotency_key: string },
  resource: ResourceRef | null,
  kind: ActionReceipt['outcome'],
): ActionReceipt => ({
  id: randomUUID(),
  action_id: ctx.action_id,
  idempotency_key: ctx.idempotency_key,
  outcome: kind,
  resource,
  external_receipt_id: null,
  occurred_at: new Date().toISOString(),
  data_mode: 'demo',
  error_code: kind === 'unknown' ? 'OUTCOME_UNKNOWN' : null,
});
const handler: ActionHandler = {
  mode: 'remote',
  validate: async (_actor, args, refs) => ({
    summary: { title: '测试受控远端提交', private_body: '不应出现在运维列表' },
    args,
    items: refs.map((resource_ref) => ({ resource_ref })),
  }),
  execute: async (ctx, _tx, action) => {
    await database.pool.query(
      'INSERT INTO reconciliation_test_effects(tenant_id,id,external_request_id,effects,settled) VALUES($1,$2,$3,1,false) ON CONFLICT(tenant_id,id) DO UPDATE SET effects=reconciliation_test_effects.effects+1',
      [tenant, action.item.resource_ref!.id, ctx.external_request_id],
    );
    return receipt(ctx, action.item.resource_ref, 'unknown');
  },
  queryOutcome: async (ctx, action) => {
    const id = action.item.resource_ref!.id;
    await queryHook(id);
    const row = (
      await database.pool.query(
        'UPDATE reconciliation_test_effects SET lookups=lookups+1 WHERE tenant_id=$1 AND id=$2 AND external_request_id=$3 RETURNING settled',
        [tenant, id, ctx.external_request_id],
      )
    ).rows[0];
    return receipt(
      ctx,
      action.item.resource_ref,
      row?.settled ? 'succeeded' : 'unknown',
    );
  },
};
const options = {
  signingSecret: 'reconciliation-integration-confirmation-secret-long-enough',
  freshActor: (a: ActorContext) => identity.requireCurrentActor(a),
  generation: async () => generation,
  assertResourceAccess: async (
    a: ActorContext,
    operation: string,
    ref: ResourceRef,
  ) => {
    await identity.assertPermission(
      a,
      operation === 'read' ? 'travel.read.own' : 'travel.write.own',
    );
    const effect = (
      await database.pool.query(
        'SELECT settled FROM reconciliation_test_effects WHERE tenant_id=$1 AND id=$2',
        [tenant, ref.id],
      )
    ).rows[0];
    if (operation !== 'read' && effect?.settled)
      throw new AppError('INVALID_STATE', '已完成的对象不能再次提交。');
  },
};
const service = () => {
  const value = createActionService(database.db, options);
  value.registerHandler('travel.submit', handler);
  return value;
};
const actions = service();
async function unknownAction(runId?: string) {
  const ref: ResourceRef = { type: 'travel', id: randomUUID(), version: 1 },
    p = await actions.prepareAction(actor, {
      action: 'travel.submit',
      resource_refs: [ref],
      args: { private_body: '不应出现在运维列表' },
      idempotency_key: randomUUID(),
      run_id: runId ?? null,
    }),
    review = await actions.getReview(actor, p.confirmation_id, {
      channel: 'browser',
    });
  const action = await actions.confirmAction(actor, p.confirmation_id, {
    expected_version: review.version,
    summary_hash: review.summary_hash,
    confirmation_token: review.confirmation_token!,
  });
  expect(action.state).toBe('unknown');
  return {
    id: action.id,
    item: action.items[0]!.id,
    ref,
    confirmation_id: p.confirmation_id,
    review,
  };
}
async function due(item: string) {
  await database.pool.query(
    "UPDATE action_attempts SET reconcile_after=clock_timestamp()-interval '1 second' WHERE id=(SELECT id FROM action_attempts WHERE item_id=$1 ORDER BY attempt DESC LIMIT 1)",
    [item],
  );
}
const scope = (id: string) => ({ tenant_id: tenant, action_id: id });
describe('unknown动作持久退避核实，不重发业务写入', () => {
  beforeAll(async () => {
    await database.pool.query(
      'CREATE TABLE IF NOT EXISTS reconciliation_test_effects(tenant_id text NOT NULL,id text NOT NULL,external_request_id text NOT NULL,effects integer NOT NULL,lookups integer NOT NULL DEFAULT 0,settled boolean NOT NULL,PRIMARY KEY(tenant_id,id))',
    );
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
    [actor, admin] = await Promise.all([login('u-li'), login('u-zhao')]);
  });
  afterAll(async () => {
    await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query(
      'DELETE FROM runtime_fairness WHERE tenant_id=$1',
      [tenant],
    );
    await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
      tenant,
    ]);
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
    await database.pool.query(
      'DELETE FROM reconciliation_test_effects WHERE tenant_id=$1',
      [tenant],
    );
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenant],
    );
    await database.close();
  });
  it('已提交对象当前不可再写时仍可读取和核实本人的旧动作回执', async () => {
    const a = await unknownAction();
    await database.pool.query(
      'UPDATE reconciliation_test_effects SET settled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, a.ref.id],
    );
    expect((await actions.getAction(actor, a.id)).state).toBe('unknown');
    expect((await actions.reconcileAction(actor, a.id)).state).toBe(
      'succeeded',
    );
    expect(
      (
        await actions.getReview(actor, a.confirmation_id, {
          channel: 'browser',
        })
      ).state,
    ).toBe('succeeded');
    expect(
      (
        await actions.confirmAction(actor, a.confirmation_id, {
          expected_version: a.review.version,
          summary_hash: a.review.summary_hash,
          confirmation_token: a.review.confirmation_token!,
        })
      ).state,
    ).toBe('succeeded');
  });
  it('重建服务后到期任务由一个Worker核实成功，仅有一次远端写入', async () => {
    const a = await unknownAction();
    await due(a.item);
    await database.pool.query(
      'UPDATE reconciliation_test_effects SET settled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, a.ref.id],
    );
    const restarted = service();
    await Promise.all([
      actions.processNextReconciliation('worker-a', scope(a.id)),
      restarted.processNextReconciliation('worker-b', scope(a.id)),
    ]);
    expect((await actions.getAction(actor, a.id)).state).toBe('succeeded');
    expect(
      (
        await database.pool.query(
          'SELECT effects,lookups FROM reconciliation_test_effects WHERE tenant_id=$1 AND id=$2',
          [tenant, a.ref.id],
        )
      ).rows[0],
    ).toEqual({ effects: 1, lookups: 1 });
  });
  it('2/5/15/30/60/300秒持久退避，十五分钟仍unknown只升级一次元数据', async () => {
    const a = await unknownAction();
    const initial = (
      await database.pool.query(
        'SELECT extract(epoch from reconcile_after-finished_at)::float AS delay FROM action_attempts WHERE item_id=$1 ORDER BY attempt DESC LIMIT 1',
        [a.item],
      )
    ).rows[0];
    expect(initial.delay).toBeGreaterThanOrEqual(1.9);
    expect(initial.delay).toBeLessThanOrEqual(2.1);
    for (const delay of [5, 15, 30, 60, 300]) {
      await due(a.item);
      await actions.processNextReconciliation('backoff-worker', scope(a.id));
      const next = (
        await database.pool.query(
          'SELECT extract(epoch from reconcile_after-finished_at)::float AS delay FROM action_attempts WHERE item_id=$1 ORDER BY attempt DESC LIMIT 1',
          [a.item],
        )
      ).rows[0];
      expect(next.delay).toBeGreaterThanOrEqual(delay - 0.1);
      expect(next.delay).toBeLessThanOrEqual(delay + 0.1);
    }
    await database.pool.query(
      "UPDATE action_attempts SET started_at=clock_timestamp()-interval '16 minutes' WHERE item_id=$1 AND kind='execute'",
      [a.item],
    );
    for (let n = 0; n < 2; n++) {
      await due(a.item);
      await actions.processNextReconciliation('escalation-worker', scope(a.id));
    }
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int count FROM action_audit WHERE action_id=$1 AND event_type='reconciliation.manual_required'",
          [a.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    const metadata = await actions.listReconciliation(admin);
    expect(
      metadata.items.some(
        (row) => row.action_id === a.id && row.manual_required,
      ),
    ).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('不应出现在运维列表');
    expect((await actions.getAction(actor, a.id)).state).toBe('unknown');
  });
  it('旧核实租约失效后不提交回执，新attempt接管后仅一条真实回执', async () => {
    const a = await unknownAction();
    await due(a.item);
    let release!: () => void, began!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        began = resolve;
      });
    let pause = true;
    queryHook = async (id) => {
      if (id === a.ref.id && pause) {
        pause = false;
        began();
        await held;
      }
    };
    const old = actions.processNextReconciliation('old-worker', scope(a.id));
    await started;
    await due(a.item);
    await database.pool.query(
      'UPDATE reconciliation_test_effects SET settled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, a.ref.id],
    );
    await service().processNextReconciliation('new-worker', scope(a.id));
    release();
    await old;
    queryHook = async () => {};
    expect((await actions.getAction(actor, a.id)).state).toBe('succeeded');
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int count FROM action_receipts WHERE item_id=$1',
          [a.item],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          'SELECT effects FROM reconciliation_test_effects WHERE tenant_id=$1 AND id=$2',
          [tenant, a.ref.id],
        )
      ).rows[0],
    ).toEqual({ effects: 1 });
  });
  it('核实期间代际变化拒绝发布旧结果，unknown保留', async () => {
    const a = await unknownAction();
    await due(a.item);
    queryHook = async (id) => {
      if (id === a.ref.id) generation = 2;
    };
    await actions.processNextReconciliation('generation-worker', scope(a.id));
    generation = 1;
    queryHook = async () => {};
    expect((await actions.getAction(actor, a.id)).state).toBe('unknown');
  });
  it('实际Worker核实端口消费reconciling run，同一action成功后续接而不重发', async () => {
    const runs = createRunService(database, {
        freshActor: (a) => identity.requireCurrentActor(a),
      }),
      run = await runs.createRun(
        actor,
        { thread_id: randomUUID(), input_message_id: randomUUID() },
        randomUUID(),
      ),
      lease = await runs.claimRun('reconcile-run-worker', {
        tenant_id: tenant,
      });
    if (!lease || lease.run.id !== run.id) throw new Error('未领取真实run');
    const action = await unknownAction(run.id),
      callId = randomUUID();
    await runs.beginTool(run.id, lease.lease_epoch, {
      call_id: callId,
      name: 'internal.action.execute',
      version: '1',
      arguments: { action_id: action.id },
      effect: 'write',
    });
    await runs.completeTool(run.id, lease.lease_epoch, callId, {
      status: 'unknown',
      data: null,
      evidence_refs: [],
      action_id: action.id,
      error_code: 'OUTCOME_UNKNOWN',
    });
    await runs.finishRun(run.id, lease.lease_epoch, 'succeeded');
    expect((await runs.getRun(actor, run.id)).status).toBe('reconciling');
    await due(action.item);
    await database.pool.query(
      'UPDATE reconciliation_test_effects SET settled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, action.ref.id],
    );
    const reconciler = createReceiptReconciler({ database, actions, runs });
    await reconciler.tick('actual-receipt-worker', scope(action.id));
    expect((await runs.getRun(actor, run.id)).status).toBe('queued');
    expect(
      (
        await database.pool.query(
          'SELECT status FROM runtime_tool_calls WHERE run_id=$1 AND call_id=$2',
          [run.id, callId],
        )
      ).rows[0],
    ).toEqual({ status: 'completed' });
    expect(
      (
        await database.pool.query(
          'SELECT effects FROM reconciliation_test_effects WHERE tenant_id=$1 AND id=$2',
          [tenant, action.ref.id],
        )
      ).rows[0],
    ).toEqual({ effects: 1 });
    await runs.cancelRun(
      actor,
      run.id,
      {
        expected_version: (await runs.getRun(actor, run.id)).version,
        reason: '测试结束',
      },
      randomUUID(),
    );
    await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query(
      'DELETE FROM runtime_fairness WHERE tenant_id=$1',
      [tenant],
    );
    await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
      tenant,
    ]);
  });
  it('核实回执查询有界超时，迟到结果不推进业务状态', async () => {
    const a = await unknownAction();
    await due(a.item);
    queryHook = async (id) => {
      if (id === a.ref.id) await new Promise(() => {});
    };
    const bounded = createActionService(database.db, {
      ...options,
      reconciliationTimeoutMs: 20,
    });
    bounded.registerHandler('travel.submit', handler);
    expect(
      await bounded.processNextReconciliation('bounded-worker', scope(a.id)),
    ).toBe(true);
    queryHook = async () => {};
    expect((await actions.getAction(actor, a.id)).state).toBe('unknown');
    expect(
      (
        await database.pool.query(
          'SELECT transport_result,finished_at IS NOT NULL AS finished,reconcile_after>finished_at AS scheduled FROM action_attempts WHERE item_id=$1 ORDER BY attempt DESC LIMIT 1',
          [a.item],
        )
      ).rows[0],
    ).toEqual({
      transport_result: 'DEPENDENCY_UNAVAILABLE',
      finished: true,
      scheduled: true,
    });
  });
  it('查询期间权限版本变化不保存成功结果，重新登录也只看原unknown', async () => {
    const a = await unknownAction();
    await due(a.item);
    await database.pool.query(
      'UPDATE reconciliation_test_effects SET settled=true WHERE tenant_id=$1 AND id=$2',
      [tenant, a.ref.id],
    );
    queryHook = async (id) => {
      if (id === a.ref.id)
        await database.pool.query(
          'UPDATE identities SET authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
          [tenant, actor.user_id],
        );
    };
    await actions.processNextReconciliation('revoked-worker', scope(a.id));
    queryHook = async () => {};
    actor = await identity.getActor(
      (
        await identity.loginDemo(actor.user_id, undefined, {
          tenantId: tenant,
          environmentId: tenant,
          generation: 1,
        })
      ).session_token,
    );
    expect((await actions.getAction(actor, a.id)).state).toBe('unknown');
  });
});
