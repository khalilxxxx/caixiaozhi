import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createMemoryService } from '../../packages/assistant/src/memory.js';
import { AppError } from '@caixiaozhi/platform/errors';
const database = createDatabase(loadConfig().databaseUrl);
const tenant = `memory-test-${randomUUID()}`;
const workerScope = { tenant_id: tenant };
let clock = new Date('2026-11-05T00:00:00Z');
let authz = 1;
let revoked = false;
let reads = 0;
let failRead = false;
const actor = (user = 'owner'): ActorContext => ({
  tenant_id: tenant,
  user_id: user,
  roles: ['manager'],
  department_ids: ['sales'],
  permissions: ['expense.read.department', 'analytics.query'],
  authz_version: authz,
  session_id: `session-${user}`,
  invocation_origin: 'interactive',
  delegation_id: null,
});
const service = createMemoryService(database, {
  freshActor: async (value) => ({ ...value, authz_version: authz }),
  clock: () => clock,
  createDelegation: async () => ({ id: randomUUID(), version: 1 }),
  resolveDelegation: async (_tenant, id) => {
    if (revoked)
      throw Object.assign(new Error('revoked'), { code: 'FORBIDDEN' });
    return {
      ...actor(),
      session_id: null,
      invocation_origin: 'subscription',
      delegation_id: id,
    };
  },
  authorizeResource: async (_actor, ref) => {
    if (revoked) throw new Error('revoked');
    return ref;
  },
  readDigest: async () => {
    reads++;
    if (failRead)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '显式测试数据源不可用。');
    return {
      title: '今天的待审报销',
      preview: '有 5 张待审报销，合计 5,540.00 元。',
      content: '销售部待审报销共 5 张。',
      source_refs: [{ type: 'expense_claim', id: 'claim-fixture', version: 1 }],
      coverage: 'complete',
      generated_at: clock.toISOString(),
    };
  },
});
const memoryInput = () => ({
  kind: 'response_preference',
  key: randomUUID(),
  content: '先给结论，再给依据。',
  value: { concise: true },
  expires_at: null,
  source: { kind: 'manual' },
  explicit_save: true,
});
const subscriptionInput = () => ({
  type: 'todo_digest',
  title: '工作日待审报销',
  schedule: {
    frequency: 'weekdays',
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
afterAll(async () => {
  for (const table of [
    'inbox_reads',
    'inbox_items',
    'digest_snapshots',
    'subscription_occurrences',
    'subscriptions',
    'memory_revisions',
    'memories',
    'memory_profiles',
    'memory_source_tombstones',
    'assistant_commands',
    'cards',
    'messages',
    'threads',
    'durable_jobs',
    'outbox_events',
  ])
    await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
      tenant,
    ]);
  await database.close();
});
describe('记忆、日程与收件箱真实持久化', () => {
  it('演示业务时钟与真实接纳时间分离：新实例可退避和重试，回拨不重复投递', async () => {
    const clockActor = actor('clock-owner');
    let unavailable = true;
    const realClock = new Date('2026-11-07T01:00:00Z');
    const scoped = createMemoryService(database, {
      freshActor: async (value) => value,
      clock: () => realClock,
      businessNow: async () => new Date('2026-11-06T00:00:00Z'),
      createDelegation: async () => ({ id: randomUUID(), version: 1 }),
      resolveDelegation: async (_tenant, id) => ({
        ...clockActor,
        session_id: null,
        invocation_origin: 'subscription',
        delegation_id: id,
      }),
      authorizeResource: async (_actor, ref) => ref,
      readDigest: async () => {
        if (unavailable)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '显式时钟测试数据源暂不可用。',
          );
        return {
          title: '时钟分离摘要',
          preview: '本次摘要可读。',
          content: '真实接纳后正常生成。',
          source_refs: [],
          coverage: 'complete',
          generated_at: '2026-11-06T01:00:00Z',
        };
      },
    });
    const created = await scoped.createSubscription(
      clockActor,
      {
        ...subscriptionInput(),
        schedule: { ...subscriptionInput().schedule, start_date: '2026-11-06' },
      },
      randomUUID(),
    );
    const scope = { tenantId: tenant, subscriptionId: created.subscription.id };
    expect(
      (
        await scoped.scheduleDueSubscriptions(
          new Date('2026-11-06T01:00:00Z'),
          30,
          scope,
        )
      ).enqueued,
    ).toBe(1);
    const occurrence = (
      await scoped.occurrences(clockActor, created.subscription.id)
    ).items[0]!;
    await scoped.generateNextDigest('clock-separation-worker', workerScope);
    expect(
      (
        await database.pool.query(
          "SELECT status FROM durable_jobs WHERE tenant_id=$1 AND kind='digest.generate' AND payload_ref=$2",
          [tenant, occurrence.id],
        )
      ).rows[0].status,
    ).toBe('ready');
    await database.pool.query(
      "UPDATE durable_jobs SET ready_at=now(),attempt=4 WHERE tenant_id=$1 AND kind='digest.generate' AND payload_ref=$2",
      [tenant, occurrence.id],
    );
    await scoped.generateNextDigest('clock-separation-worker', workerScope);
    const failed = (
      await scoped.occurrences(clockActor, created.subscription.id)
    ).items[0]!;
    expect(failed.status).toBe('failed');
    await scoped.retryOccurrence(
      clockActor,
      created.subscription.id,
      failed.id,
      failed.version,
      randomUUID(),
    );
    unavailable = false;
    await scoped.generateNextDigest('clock-separation-worker', workerScope);
    const event = (
      await database.pool.query(
        "SELECT e.id,d.generated_at FROM outbox_events e JOIN digest_snapshots d ON d.tenant_id=e.tenant_id AND d.id=e.resource_id WHERE e.tenant_id=$1 AND d.occurrence_id=$2 AND e.event_type='digest.generated' ORDER BY e.created_at DESC,e.id DESC LIMIT 1",
        [tenant, occurrence.id],
      )
    ).rows[0];
    expect(new Date(event.generated_at).toISOString()).toBe(
      realClock.toISOString(),
    );
    await scoped.deliverInbox(event.id);
    const item = (await scoped.listInbox(clockActor)).items.find(
      (value) => value.title === '时钟分离摘要',
    )!;
    expect(item.preview).toBe('本次摘要可读。');
    expect(
      (
        await scoped.scheduleDueSubscriptions(
          new Date('2026-11-05T01:00:00Z'),
          30,
          scope,
        )
      ).enqueued,
    ).toBe(0);
    expect(
      (
        await scoped.scheduleDueSubscriptions(
          new Date('2026-11-06T01:00:00Z'),
          30,
          scope,
        )
      ).enqueued,
    ).toBe(0);
    expect(
      (await scoped.occurrences(clockActor, created.subscription.id)).items,
    ).toHaveLength(1);
    expect(
      (await scoped.listInbox(clockActor)).items.filter(
        (value) => value.id === item.id,
      ),
    ).toHaveLength(1);
    await scoped.changeSubscription(
      clockActor,
      created.subscription.id,
      'pause',
      created.subscription.version,
      randomUUID(),
    );
  });
  it('只有明确保存才写入，审核阈值分流到rules，跨用户不能删除', async () => {
    await expect(
      service.saveMemory(
        actor(),
        { ...memoryInput(), explicit_save: false },
        randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      service.saveMemory(
        actor(),
        { ...memoryInput(), content: '餐饮费超过1000元提醒我关注。' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      details: { reason: 'RULE_THRESHOLD_REQUIRES_RULE' },
    });
    const saved = await service.saveMemory(
      actor(),
      memoryInput(),
      randomUUID(),
    );
    await expect(
      service.deleteMemory(actor('other'), saved.memory.id, 1, randomUUID()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await service.selectMemoryContext(actor(), [saved.memory.key])).items,
    ).toHaveLength(1);
    await service.deleteMemory(actor(), saved.memory.id, 1, randomUUID());
    expect(
      (await service.selectMemoryContext(actor(), [saved.memory.key])).items,
    ).toHaveLength(0);
    await expect(
      service.assertMemoryEpoch(actor(), saved.memory_epoch),
    ).rejects.toMatchObject({ details: { reason: 'MEMORY_EPOCH_CHANGED' } });
  });
  it('到期即时排除且epoch推进，不依赖缓存TTL', async () => {
    const saved = await service.saveMemory(
      actor(),
      { ...memoryInput(), expires_at: '2026-11-05T00:01:00Z' },
      randomUUID(),
    );
    clock = new Date('2026-11-05T00:01:00Z');
    const selected = await service.selectMemoryContext(actor(), [
      saved.memory.key,
    ]);
    expect(selected.items).toEqual([]);
    expect(selected.memory_epoch).toBeGreaterThan(saved.memory_epoch);
    clock = new Date('2026-11-05T00:00:00Z');
  });
  it('same_schedule_slot_one_delivery：双scheduler只建一个occurrence/job，投递前0聊天，点击复用thread/card', async () => {
    const created = await service.createSubscription(
      actor(),
      subscriptionInput(),
      randomUUID(),
    );
    clock = new Date('2026-11-05T01:00:00Z');
    const scheduled = await Promise.all([
      service.scheduleDueSubscriptions(clock, 30, {
        tenantId: tenant,
        subscriptionId: created.subscription.id,
      }),
      service.scheduleDueSubscriptions(clock, 30, {
        tenantId: tenant,
        subscriptionId: created.subscription.id,
      }),
    ]);
    expect(scheduled.reduce((n, r) => n + r.enqueued, 0)).toBe(1);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM threads WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
    ).toBe(0);
    await service.generateNextDigest('digest-worker', workerScope);
    expect(reads).toBe(1);
    const occurrence = (
      await service.occurrences(actor(), created.subscription.id)
    ).items[0]!;
    const outbox = (
      await database.pool.query(
        "SELECT e.id FROM outbox_events e JOIN digest_snapshots d ON d.tenant_id=e.tenant_id AND d.id=e.resource_id WHERE e.tenant_id=$1 AND e.event_type='digest.generated' AND d.occurrence_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1",
        [tenant, occurrence.id],
      )
    ).rows[0];
    expect(outbox).toBeTruthy();
    const first = await service.deliverInbox(outbox.id);
    const again = await service.deliverInbox(outbox.id);
    expect(first.created).toBe(true);
    expect(again.item_id).toBe(first.item_id);
    expect(again.created).toBe(false);
    expect(await service.unreadCount(actor())).toBe(1);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM threads WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
    ).toBe(0);
    const item = (await service.listInbox(actor())).items[0]!;
    const [a, b] = await Promise.all([
      service.openInbox(actor(), item.id, item.version, randomUUID()),
      service.openInbox(actor(), item.id, item.version, randomUUID()),
    ]);
    expect(a.thread_id).toBe(b.thread_id);
    expect(a.card_id).toBe(b.card_id);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM cards WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
    ).toBe(1);
    await service.markRead(
      actor(),
      item.id,
      { expected_version: item.version, read_revision: item.revision },
      randomUUID(),
    );
    expect(await service.unreadCount(actor())).toBe(0);
    await service.changeSubscription(
      actor(),
      created.subscription.id,
      'pause',
      created.subscription.version,
      randomUUID(),
    );
  });
  it('revoked_scope_no_summary_leak：权限版本改变后预览清除且未读不泄漏旧摘要', async () => {
    authz = 2;
    const items = (await service.listInbox(actor())).items;
    expect(items[0]?.preview).not.toContain('5,540');
    expect(items[0]?.title).toBe('此摘要暂不可查看');
    expect(await service.unreadCount(actor())).toBe(0);
    await expect(
      service.openInbox(actor(), items[0]!.id, items[0]!.version, randomUUID()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    authz = 1;
  });
  it('暂停生成中日程阻止投递，长停机只补最新六小时内实例', async () => {
    clock = new Date('2026-11-06T00:00:00Z');
    const created = await service.createSubscription(
      actor(),
      subscriptionInput(),
      randomUUID(),
    );
    clock = new Date('2026-11-09T03:00:00Z');
    await service.scheduleDueSubscriptions(clock, 30, {
      tenantId: tenant,
      subscriptionId: created.subscription.id,
    });
    const occurrences = await service.occurrences(
      actor(),
      created.subscription.id,
    );
    expect(
      occurrences.items.filter((o) => o.status === 'scheduled'),
    ).toHaveLength(1);
    expect(
      occurrences.items.some((o) => o.status === 'skipped_coalesced'),
    ).toBe(true);
    await service.generateNextDigest('digest-worker', workerScope);
    await service.changeSubscription(
      actor(),
      created.subscription.id,
      'pause',
      created.subscription.version,
      randomUUID(),
    );
    const pending = (
      await database.pool.query(
        "SELECT e.id FROM outbox_events e JOIN digest_snapshots d ON d.tenant_id=e.tenant_id AND d.id=e.resource_id JOIN subscription_occurrences o ON o.tenant_id=d.tenant_id AND o.id=d.occurrence_id WHERE e.tenant_id=$1 AND e.event_type='digest.generated' AND e.published_at IS NULL AND o.subscription_id=$2",
        [tenant, created.subscription.id],
      )
    ).rows;
    for (const entry of pending)
      expect((await service.deliverInbox(entry.id)).created).toBe(false);
  });
  it('失败摘要显式重试复用item/thread并推进revision，只增加一条未读', async () => {
    clock = new Date('2026-11-04T00:00:00Z');
    const input = {
      ...subscriptionInput(),
      schedule: { ...subscriptionInput().schedule, start_date: '2026-11-04' },
    };
    const created = await service.createSubscription(
      actor(),
      input,
      randomUUID(),
    );
    clock = new Date('2026-11-04T01:00:00Z');
    await service.scheduleDueSubscriptions(clock, 30, {
      tenantId: tenant,
      subscriptionId: created.subscription.id,
    });
    const occurrence = (
      await service.occurrences(actor(), created.subscription.id)
    ).items[0]!;
    await database.pool.query(
      "UPDATE durable_jobs SET attempt=4 WHERE tenant_id=$1 AND kind='digest.generate' AND payload_ref=$2",
      [tenant, occurrence.id],
    );
    failRead = true;
    await service.generateNextDigest('failure-digest-worker', workerScope);
    failRead = false;
    await service.deliverPending(30, workerScope);
    let item = (await service.listInbox(actor())).items.find(
      (item) => item.title === '今天的待办摘要暂未生成',
    )!;
    expect(item).toBeTruthy();
    const first = await service.openInbox(
      actor(),
      item.id,
      item.version,
      randomUUID(),
    );
    await service.markRead(
      actor(),
      item.id,
      { expected_version: item.version, read_revision: item.revision },
      randomUUID(),
    );
    const current = (
      await service.occurrences(actor(), created.subscription.id)
    ).items[0]!;
    expect(current.status).toBe('failed');
    await service.retryOccurrence(
      actor(),
      created.subscription.id,
      current.id,
      current.version,
      randomUUID(),
    );
    clock = new Date('2026-11-04T01:01:00Z');
    await service.generateNextDigest('failure-digest-worker', workerScope);
    await service.deliverPending(30, workerScope);
    item = (await service.listInbox(actor())).items.find(
      (value) => value.id === item.id,
    )!;
    expect(item.revision).toBe(2);
    expect(item.unread).toBe(true);
    expect(
      (await service.listInbox(actor())).items.filter(
        (value) => value.id === item.id,
      ),
    ).toHaveLength(1);
    const reopened = await service.openInbox(
      actor(),
      item.id,
      item.version,
      randomUUID(),
    );
    expect(reopened.thread_id).toBe(first.thread_id);
    const text = await database.pool.query(
      'SELECT content FROM messages WHERE tenant_id=$1 AND thread_id=$2',
      [tenant, first.thread_id],
    );
    expect(text.rows[0].content).not.toContain('生成失败');
    await service.markRead(
      actor(),
      item.id,
      { expected_version: item.version, read_revision: item.revision },
      randomUUID(),
    );
    await service.changeSubscription(
      actor(),
      created.subscription.id,
      'pause',
      created.subscription.version,
      randomUUID(),
    );
    clock = new Date('2026-11-05T00:00:00Z');
    reads = 0;
  });
});
