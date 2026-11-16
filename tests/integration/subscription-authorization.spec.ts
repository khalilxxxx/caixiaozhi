import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';

const config = {
  ...loadConfig(),
  appMode: 'demo' as const,
  demoAccessEnabled: true,
  cookieSecure: false,
  logLevel: 'silent' as const,
};
const database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `subscription-auth-${randomUUID()}`,
  envId = `env-${tenant}`;
const services = createConfiguredApplication({
  database,
  storage,
  config,
  demoTenantId: tenant,
  demoEnvironmentId: envId,
});
let zhang: ActorContext, li: ActorContext;
const input = () => ({
  type: 'todo_digest',
  title: '真实只读待办摘要',
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
});
describe('真实应用订阅只读授权接缝', () => {
  beforeAll(async () => {
    await services.demo.initialize();
    const login = async (user: string) => {
      const session = await services.identity.loginDemo(user, undefined, {
        tenantId: tenant,
        environmentId: envId,
        generation: 1,
      });
      return services.identity.getActor(session.session_token);
    };
    zhang = await login('u-zhang');
    li = await login('u-li');
  }, 30000);
  afterAll(async () => {
    storage.close();
    await database.close();
  });
  it('无审批写权限的真实委托读取本人指派且有按单据类型部门读授权的任务，真实生成并投递摘要', async () => {
    const subscription = await services.memory.createSubscription(
      zhang,
      input(),
      randomUUID(),
    );
    const stored = (
      await database.pool.query(
        'SELECT delegation_id FROM subscriptions WHERE tenant_id=$1 AND id=$2',
        [tenant, subscription.subscription.id],
      )
    ).rows[0];
    const delegated = await services.identity.getActorFromSubscription(
      tenant,
      stored.delegation_id,
    );
    expect(delegated.invocation_origin).toBe('subscription');
    expect(delegated.permissions).not.toContain('approval.decide');
    expect(delegated.permissions).not.toContain('expense.write.own');
    expect(delegated.permissions).not.toContain('skill.use');
    const baseline = await services.approvals.list(delegated, { limit: 100 });
    expect(baseline.count).toBe(5);
    expect(baseline.page_total.amount_minor).toBe('554000');
    const narrow = await services.identity.createSubscriptionDelegation(zhang, {
      subscriptionId: `explicit-travel-only-${randomUUID()}`,
      allowedCapabilities: ['travel.read.department'],
    });
    const travelOnly = await services.identity.getActorFromSubscription(
      tenant,
      narrow.id,
    );
    expect(
      (await services.approvals.list(travelOnly, { limit: 100 })).items,
    ).toEqual([]);
    await expect(services.approvals.list(li)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // 同部门但非指派、本人指派但跨部门，两种记录都必须在SQL选择阶段排除。
    await database.pool.query(
      "UPDATE approval_tasks SET assigned_to='u-sun' WHERE tenant_id=$1 AND id='at-005'",
      [tenant],
    );
    await database.pool.query(
      "UPDATE approval_tasks SET assigned_to='u-zhang' WHERE tenant_id=$1 AND id='at-006'",
      [tenant],
    );
    try {
      const visible = await services.approvals.list(delegated, { limit: 100 });
      expect(visible.count).toBe(4);
      expect(
        visible.items.map((item) => item.document.resource_ref.id),
      ).toEqual(['clm-001', 'clm-002', 'clm-003', 'clm-004']);
      expect(visible.page_total.amount_minor).toBe('498000');
      await expect(
        services.documents.get(delegated, 'expense_claim', 'clm-006'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        services.actions.prepareAction(delegated, {
          action: 'approval.approve',
          resource_refs: [visible.items[0]!.document.resource_ref],
          args: { task_ref: visible.items[0]!.task_ref },
          idempotency_key: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const at = new Date(subscription.subscription.next_run_at!);
      expect(
        (
          await services.memory.scheduleDueSubscriptions(at, 30, {
            tenantId: tenant,
            subscriptionId: subscription.subscription.id,
          })
        ).enqueued,
      ).toBe(1);
      expect(
        await services.memory.generateNextDigest(
          'real-subscription-auth-worker',
          { tenant_id: tenant },
        ),
      ).toBe(true);
      expect(
        await services.memory.deliverPending(30, { tenant_id: tenant }),
      ).toEqual({ delivered: 1 });
      const inbox = await services.memory.listInbox(zhang);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0]!.preview).toContain('演示报销 clm-001');
      expect(inbox.items[0]!.preview).not.toContain('clm-005');
      expect(inbox.items[0]!.preview).not.toContain('clm-006');
      expect(inbox.items[0]!.preview).not.toContain('undefined');
      const snapshot = (
        await database.pool.query(
          'SELECT source_refs,content_json FROM digest_snapshots WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0];
      expect(snapshot.source_refs.map((ref: { id: string }) => ref.id)).toEqual(
        ['clm-001', 'clm-002', 'clm-003', 'clm-004'],
      );
      expect(snapshot.content_json.content).toContain('演示报销 clm-001');
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM actions WHERE tenant_id=$1',
            [tenant],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await database.pool.query(
        "UPDATE approval_tasks SET assigned_to='u-zhang' WHERE tenant_id=$1 AND id='at-005'",
        [tenant],
      );
      await database.pool.query(
        "UPDATE approval_tasks SET assigned_to='u-sun' WHERE tenant_id=$1 AND id='at-006'",
        [tenant],
      );
      await services.memory.changeSubscription(
        zhang,
        subscription.subscription.id,
        'pause',
        subscription.subscription.version,
        randomUUID(),
      );
    }
  });
  it('订阅Skill校验拒绝未通过真实验证的版本，不通过use权限开放源码或补写source_read授权', async () => {
    const before = (
      await database.pool.query(
        "SELECT count(*)::int n FROM skill_grants WHERE tenant_id=$1 AND action='source_read'",
        [tenant],
      )
    ).rows[0].n;
    await expect(
      services.skills.getSkillSource(
        li,
        'skill-knowledge',
        'skill-knowledge-v1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      services.skills.validateForSubscription(li, 'skill-knowledge-v1'),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    await expect(
      services.memory.createSubscription(
        li,
        { ...input(), skill_version_id: 'skill-knowledge-v1' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    const after = (
      await database.pool.query(
        "SELECT count(*)::int n FROM skill_grants WHERE tenant_id=$1 AND action='source_read'",
        [tenant],
      )
    ).rows[0].n;
    expect(after).toBe(before);
  });
});
