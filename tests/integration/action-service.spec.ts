import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { AppError } from '@caixiaozhi/platform/errors';
import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
} from '@caixiaozhi/contracts';
import { createActionService } from '../../packages/action-service/src/index.js';
import type { ActionHandler } from '../../packages/business-adapters/src/ports.js';

const database = createDatabase(loadConfig().databaseUrl);
const tenant = `action-test-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'u-test',
  roles: ['employee'],
  department_ids: ['dep'],
  permissions: ['travel.write.own'],
  authz_version: 1,
  session_id: 'session-one',
  invocation_origin: 'interactive',
  delegation_id: null,
};
let currentActor = actor;
let clock = Date.now();
const options = {
  signingSecret: 'integration-test-signing-secret-more-than-32-characters',
  freshActor: async () => currentActor,
  assertResourceAccess: async () => {},
  now: () => new Date(clock),
};
const service = createActionService(database.db, options);
const ref = (id: string): ResourceRef => ({ type: 'travel', id, version: 1 });
const key = () => randomUUID();
const makeReceipt = (
  ctx: { action_id: string; idempotency_key: string },
  resource: ResourceRef | null,
  outcome: ActionReceipt['outcome'] = 'succeeded',
): ActionReceipt => ({
  id: randomUUID(),
  action_id: ctx.action_id,
  idempotency_key: ctx.idempotency_key,
  outcome,
  resource,
  external_receipt_id: null,
  occurred_at: new Date().toISOString(),
  data_mode: 'demo',
  error_code: outcome === 'unknown' ? 'OUTCOME_UNKNOWN' : null,
});
const local: ActionHandler<{ note: string }> = {
  async validate(_a, args, refs, tx) {
    for (const r of refs) {
      const result = await (tx ?? database.db).execute(
        sql`SELECT version FROM action_test_business WHERE tenant_id=${tenant} AND id=${r.id}`,
      );
      if (!result.rows[0] || result.rows[0].version !== r.version)
        throw Object.assign(new Error('版本变化'), {
          code: 'VERSION_CONFLICT',
        });
    }
    return {
      summary: { title: '提交差旅', note: args.note },
      args,
      items: refs.map((resource_ref) => ({ resource_ref })),
    };
  },
  async execute(ctx, tx, action) {
    const r = action.item.resource_ref!;
    await tx!.execute(
      sql`UPDATE action_test_business SET version=version+1,effects=effects+1 WHERE tenant_id=${tenant} AND id=${r.id}`,
    );
    return makeReceipt(ctx, { ...r, version: 2 });
  },
  async queryOutcome(ctx, action) {
    const rows = await database.db.execute(
      sql`SELECT effects FROM action_test_business WHERE tenant_id=${tenant} AND id=${action.item.resource_ref!.id}`,
    );
    return makeReceipt(
      ctx,
      action.item.resource_ref,
      rows.rows[0]?.effects === 1 ? 'succeeded' : 'unknown',
    );
  },
};
service.registerHandler('travel.submit', local);
async function prepare(ids: string[], note = '出差') {
  for (const id of ids)
    await database.db.execute(
      sql`INSERT INTO action_test_business(tenant_id,id,version,effects) VALUES(${tenant},${id},1,0) ON CONFLICT DO NOTHING`,
    );
  return service.prepareAction(actor, {
    action: 'travel.submit',
    resource_refs: ids.map(ref),
    args: { note },
    idempotency_key: key(),
  });
}
async function confirm(id: string) {
  const review = await service.getReview(actor, id, { channel: 'browser' });
  return service.confirmAction(actor, id, {
    expected_version: review.version,
    summary_hash: review.summary_hash,
    confirmation_token: review.confirmation_token!,
  });
}
describe('公共动作真实持久化与确认边界', () => {
  beforeAll(async () => {
    await database.db.execute(
      sql`CREATE TABLE IF NOT EXISTS action_test_business(tenant_id text,id text,version int,effects int,PRIMARY KEY(tenant_id,id))`,
    );
  });
  afterAll(async () => {
    await database.db.execute(
      sql`DELETE FROM action_audit WHERE tenant_id=${tenant}`,
    );
    await database.db.execute(
      sql`DELETE FROM action_attempts WHERE tenant_id=${tenant}`,
    );
    await database.db.execute(
      sql`DELETE FROM action_receipts WHERE tenant_id=${tenant}`,
    );
    await database.db.execute(
      sql`DELETE FROM action_items WHERE tenant_id=${tenant}`,
    );
    await database.db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`DELETE FROM actions WHERE tenant_id=${tenant}`);
      await tx.execute(
        sql`DELETE FROM confirmations WHERE tenant_id=${tenant}`,
      );
    });
    await database.db.execute(
      sql`DELETE FROM action_test_business WHERE tenant_id=${tenant}`,
    );
    await database.close();
  });
  it('same_key_same_payload_one_action；参数变化同键冲突', async () => {
    const id = key();
    await database.db.execute(
      sql`INSERT INTO action_test_business VALUES(${tenant},${id},1,0)`,
    );
    const input = {
      action: 'travel.submit' as const,
      resource_refs: [ref(id)],
      args: { note: '出差' },
      idempotency_key: key(),
    };
    const [a, b] = await Promise.all([
      service.prepareAction(actor, input),
      service.prepareAction(actor, input),
    ]);
    expect(a.action_id).toBe(b.action_id);
    await expect(
      service.prepareAction(actor, { ...input, args: { note: '改变' } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(JSON.stringify(a)).not.toContain('confirmation_token');
  });
  it('只有本人同一浏览器会话取令牌，模型无凭证', async () => {
    const p = await prepare([key()]);
    await expect(
      service.getReview(
        { ...actor, session_id: 'other-session' },
        p.confirmation_id,
        { channel: 'browser' },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.getReview(actor, p.confirmation_id, { channel: 'tool' } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const review = await service.getReview(actor, p.confirmation_id, {
      channel: 'browser',
    });
    expect(review.confirmation_token).toBeTruthy();
    await expect(
      service.confirmAction(actor, p.confirmation_id, {
        expected_version: 1,
        summary_hash: review.summary_hash,
        confirmation_token: 'forged',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('并发确认与原子执行只产生一次业务效果；新service仍可查原回执', async () => {
    const id = key();
    const p = await prepare([id]);
    const [a, b] = await Promise.all([
      confirm(p.confirmation_id),
      confirm(p.confirmation_id),
    ]);
    expect(a.id).toBe(b.id);
    const effects = await database.db.execute(
      sql`SELECT effects FROM action_test_business WHERE tenant_id=${tenant} AND id=${id}`,
    );
    expect(effects.rows[0]).toEqual({ effects: 1 });
    const restarted = createActionService(database.db, options);
    restarted.registerHandler('travel.submit', local);
    const persisted = await restarted.getAction(actor, p.action_id);
    expect(persisted.state).toBe('succeeded');
    expect(persisted.items[0]?.receipt?.resource?.version).toBe(2);
  });
  it('旧版本确认不覆盖更新，失败领域事务不留业务效果', async () => {
    const id = key(),
      p = await prepare([id]);
    await database.db.execute(
      sql`UPDATE action_test_business SET version=2 WHERE tenant_id=${tenant} AND id=${id}`,
    );
    const result = await confirm(p.confirmation_id);
    expect(result.items[0]?.receipt?.error_code).toBe('VERSION_CONFLICT');
    expect(result.state).toBe('rejected');
    expect(
      (
        await database.db.execute(
          sql`SELECT effects FROM action_test_business WHERE tenant_id=${tenant} AND id=${id}`,
        )
      ).rows[0],
    ).toEqual({ effects: 0 });
  });
  it('真实10分钟过期；业务时钟不参与授权', async () => {
    const p = await prepare([key()]);
    clock += 600001;
    await expect(
      service.getReview(actor, p.confirmation_id, { channel: 'browser' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
    clock = Date.now();
  });
  it('准备后撤权阻止确认', async () => {
    const p = await prepare([key()]);
    currentActor = { ...actor, authz_version: 2, permissions: [] };
    await expect(confirm(p.confirmation_id)).rejects.toMatchObject({
      code: 'REVALIDATION_REQUIRED',
    });
    currentActor = actor;
  });
  it('逐项批次保留成功和冲突结果', async () => {
    const ids = [key(), key()],
      p = await prepare(ids);
    await database.db.execute(
      sql`UPDATE action_test_business SET version=2 WHERE tenant_id=${tenant} AND id=${ids[1]}`,
    );
    const result = await confirm(p.confirmation_id);
    expect(result.summary).toMatchObject({
      succeeded: 1,
      rejected: 1,
      unknown: 0,
    });
    expect(result.items[0]?.receipt?.outcome).toBe('succeeded');
  });
  it('unknown仅查询回执，不重发外部写入', async () => {
    let sends = 0;
    service.registerHandler('oa.message.send', {
      mode: 'remote',
      validate: async () => ({
        summary: { title: '演示通知' },
        items: [{ resource_ref: null }],
      }),
      execute: async (ctx) => {
        sends++;
        return makeReceipt(ctx, null, 'unknown');
      },
      queryOutcome: async (ctx) => makeReceipt(ctx, null, 'unknown'),
    });
    const p = await service.prepareAction(actor, {
      action: 'oa.message.send',
      resource_refs: [],
      args: {},
      idempotency_key: key(),
    });
    expect((await confirm(p.confirmation_id)).state).toBe('unknown');
    expect((await service.reconcileAction(actor, p.action_id)).state).toBe(
      'unknown',
    );
    await service.executeAction(p.action_id);
    expect(sends).toBe(1);
  });
  it('本地业务异常时领域效果与成功回执一起回滚', async () => {
    const id = key();
    await database.db.execute(
      sql`INSERT INTO action_test_business VALUES(${tenant},${id},1,0)`,
    );
    service.registerHandler('travel.resubmit', {
      ...local,
      execute: async (ctx, tx, action) => {
        await local.execute(ctx, tx, action);
        throw new Error('提交之前中断');
      },
    });
    const p = await service.prepareAction(actor, {
      action: 'travel.resubmit',
      resource_refs: [ref(id)],
      args: { note: '出差' },
      idempotency_key: key(),
    });
    const result = await confirm(p.confirmation_id);
    expect(result.state).toBe('failed');
    expect(
      (
        await database.db.execute(
          sql`SELECT version,effects FROM action_test_business WHERE tenant_id=${tenant} AND id=${id}`,
        )
      ).rows[0],
    ).toEqual({ version: 1, effects: 0 });
  });
  it('取消在途批次保留第一项真实结果，仅取消未启动项', async () => {
    let release: () => void = () => {},
      entered: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    service.registerHandler('travel.withdraw', {
      ...local,
      mode: 'remote',
      execute: async (ctx, _tx, action) => {
        entered();
        await barrier;
        return makeReceipt(ctx, action.item.resource_ref);
      },
    });
    const ids = [key(), key()];
    for (const id of ids)
      await database.db.execute(
        sql`INSERT INTO action_test_business VALUES(${tenant},${id},1,0)`,
      );
    const p = await service.prepareAction(actor, {
      action: 'travel.withdraw',
      resource_refs: ids.map(ref),
      args: { note: '撤回' },
      idempotency_key: key(),
    });
    const pending = confirm(p.confirmation_id);
    await started;
    const running = await service.getAction(actor, p.action_id),
      cancelled = await service.cancelAction(
        actor,
        p.action_id,
        running.version,
      );
    expect(cancelled.items.map((i) => i.state)).toEqual([
      'executing',
      'cancelled',
    ]);
    release();
    const final = await pending;
    expect(final.summary).toMatchObject({ succeeded: 1, cancelled: 1 });
    expect(final.items[0]?.receipt?.outcome).toBe('succeeded');
  });
  it('unknown资源不能通过新幂等键和新确认重发命令', async () => {
    const id = key();
    await database.db.execute(
      sql`INSERT INTO action_test_business VALUES(${tenant},${id},1,0)`,
    );
    service.registerHandler('oa.withdraw', {
      mode: 'remote',
      validate: async (_a, args, refs) => ({
        summary: { title: '远程撤回' },
        args,
        items: refs.map((resource_ref) => ({ resource_ref })),
      }),
      execute: async (ctx, _tx, action) =>
        makeReceipt(ctx, action.item.resource_ref, 'unknown'),
      queryOutcome: async (ctx, action) =>
        makeReceipt(ctx, action.item.resource_ref, 'unknown'),
    });
    const one = await service.prepareAction(actor, {
      action: 'oa.withdraw',
      resource_refs: [ref(id)],
      args: {},
      idempotency_key: key(),
    });
    expect((await confirm(one.confirmation_id)).state).toBe('unknown');
    const second = await prepare([id]);
    await expect(confirm(second.confirmation_id)).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    });
  });
  it('远端包装器证明本地回滚成功时保留前置拒绝，不误标unknown', async () => {
    service.registerHandler('oa.resubmit', {
      mode: 'remote',
      validate: async () => ({
        summary: { title: '已证明回滚的本地包装' },
        items: [{ resource_ref: null }],
      }),
      execute: async () => {
        throw new AppError('VERSION_CONFLICT', '已回滚。', {
          details: { effect_not_started: true },
        });
      },
      queryOutcome: async (ctx) => makeReceipt(ctx, null, 'unknown'),
    });
    const p = await service.prepareAction(actor, {
        action: 'oa.resubmit',
        resource_refs: [],
        args: {},
        idempotency_key: key(),
      }),
      result = await confirm(p.confirmation_id);
    expect(result.state).toBe('rejected');
    expect(result.items[0]?.receipt?.error_code).toBe('VERSION_CONFLICT');
  });
});
