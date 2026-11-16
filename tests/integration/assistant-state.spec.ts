import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createAssistantService } from '../../packages/assistant/src/assistant.js';
const database = createDatabase(loadConfig().databaseUrl);
const tenant = `assistant-test-${randomUUID()}`;
let authzVersion = 1;
const actor = (user = 'user-a'): ActorContext => ({
  tenant_id: tenant,
  user_id: user,
  roles: ['employee'],
  department_ids: [],
  permissions: [],
  authz_version: authzVersion,
  session_id: `session-${user}`,
  invocation_origin: 'interactive',
  delegation_id: null,
});
const freshActor = async (value: ActorContext) => value;
const runs = createRunService(database, { freshActor });
let allowed = true;
let currentVersion = 1;
const assistant = createAssistantService(database, {
  runs,
  freshActor,
  authorizeResource: async (_actor, ref) => {
    if (!allowed) throw new Error('revoked');
    return { ...ref, version: currentVersion };
  },
  home: async () => ({
    pending_count: 5,
    total: { amount_minor: '554000', currency: 'CNY' },
  }),
});
const message = (content = '请查询政策') => ({
  content,
  client_message_id: randomUUID(),
  intent: 'continue' as const,
  resource_refs: [],
  attachment_ids: [],
});
const newThread = () =>
  assistant.createThread(
    actor(),
    { title: null, initial_message: message() },
    randomUUID(),
  );
afterAll(async () => {
  await database.pool.query(
    'UPDATE threads SET active_run_id=NULL WHERE tenant_id=$1',
    [tenant],
  );
  await database.pool.query('DELETE FROM cards WHERE tenant_id=$1', [tenant]);
  await database.pool.query('DELETE FROM messages WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query(
    'DELETE FROM thread_entry_bindings WHERE tenant_id=$1',
    [tenant],
  );
  await database.pool.query(
    'DELETE FROM assistant_commands WHERE tenant_id=$1',
    [tenant],
  );
  await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM threads WHERE tenant_id=$1', [tenant]);
  await database.pool.query('DELETE FROM runtime_fairness WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.close();
});
describe('真实会话持久化与事件投影', () => {
  it('撤权后SSE与历史消息/卡片清除旧内容，resume更新run也不复活旧授权快照', async () => {
    const created = await newThread();
    const claim = await runs.claimRun('authz-test');
    const messageId = randomUUID();
    await runs.appendEvent(
      created.run_id!,
      claim!.lease_epoch,
      'assistant.message',
      { id: messageId, text: '旧授权敏感金额 999999' },
    );
    const cardId = randomUUID();
    await runs.appendEvent(created.run_id!, claim!.lease_epoch, 'card.upsert', {
      id: cardId,
      schema_version: 1,
      type: 'todo_summary',
      thread_id: created.thread.id,
      message_id: messageId,
      run_id: created.run_id,
      title: '旧授权敏感标题',
      summary: '旧授权敏感金额 999999',
      snapshot_at: new Date().toISOString(),
      resource_refs: [],
      payload: {
        count: 1,
        total: { amount_minor: '999999', currency: 'CNY' },
        list_scope: 'current_approval_scope',
        source_as_of: new Date().toISOString(),
      },
      actions: [],
      revision: 1,
      stale: false,
    });
    const point = await runs.saveCheckpoint(
      created.run_id!,
      claim!.lease_epoch,
      CheckpointSchema.parse({ stage: 'waiting_user' }),
    );
    authzVersion = 2;
    await expect(
      runs.events(actor(), created.run_id!, 0),
    ).rejects.toMatchObject({
      details: { reason: 'PERMISSION_CONTEXT_CHANGED' },
    });
    expect((await runs.snapshot(actor(), created.run_id!)).events).toEqual([]);
    expect(
      JSON.stringify(await assistant.snapshot(actor(), created.thread.id)),
    ).not.toContain('999999');
    expect(await assistant.getCard(actor(), cardId)).toMatchObject({
      unavailable: true,
    });
    const waiting = await runs.getRun(actor(), created.run_id!);
    await runs.resumeRun(
      actor(),
      created.run_id!,
      {
        expected_version: waiting.version,
        checkpoint_id: point,
        input: { text: '仅查询当前范围' },
      },
      randomUUID(),
    );
    await expect(
      runs.events(actor(), created.run_id!, 0),
    ).rejects.toMatchObject({
      details: { reason: 'PERMISSION_CONTEXT_CHANGED' },
    });
    expect(
      JSON.stringify(await assistant.snapshot(actor(), created.thread.id)),
    ).not.toContain('999999');
    const next = await runs.claimRun('authz-test');
    await runs.finishRun(next!.run.id, next!.lease_epoch, 'succeeded');
    authzVersion = 1;
  });
  it('home_does_not_auto_create_message：首页反复读取0写入', async () => {
    const before = (
      await database.pool.query(
        'SELECT count(*)::int n FROM threads WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].n;
    expect((await assistant.home(actor())).business).toMatchObject({
      pending_count: 5,
      total: { amount_minor: '554000' },
    });
    await assistant.home(actor());
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM threads WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
    ).toBe(before);
  });
  it('用户消息/run/job/outbox原子保存，幂等双击同一消息只有一条', async () => {
    const input = { title: null, initial_message: message() };
    const key = randomUUID();
    const [a, b] = await Promise.all([
      assistant.createThread(actor(), input, key),
      assistant.createThread(actor(), input, key),
    ]);
    expect(a.thread.id).toBe(b.thread.id);
    expect(a.run_id).toBe(b.run_id);
    const result = await database.pool.query(
      'SELECT count(*)::int n FROM messages WHERE tenant_id=$1 AND thread_id=$2',
      [tenant, a.thread.id],
    );
    expect(result.rows[0].n).toBe(1);
    expect((await runs.getRun(actor(), a.run_id!)).status).toBe('queued');
    const claim = await runs.claimRun('test');
    await runs.finishRun(claim!.run.id, claim!.lease_epoch, 'succeeded');
  });
  it('两标签页不同消息CAS竞争不产生第二个run；queued/running补充续接同run', async () => {
    const created = await newThread();
    const snapshot = await assistant.snapshot(actor(), created.thread.id);
    const input = {
      ...message('补充一个问题'),
      expected_version: snapshot.thread.version,
    };
    const [a, b] = await Promise.allSettled([
      assistant.acceptMessage(actor(), created.thread.id, input, randomUUID()),
      assistant.acceptMessage(
        actor(),
        created.thread.id,
        { ...message('另一个问题'), expected_version: snapshot.thread.version },
        randomUUID(),
      ),
    ]);
    expect([a, b].filter((value) => value.status === 'fulfilled')).toHaveLength(
      1,
    );
    const result = (
      a.status === 'fulfilled' ? a : b.status === 'fulfilled' ? b : null
    )!;
    if (result.status === 'fulfilled')
      expect(result.value.run_id).toBe(created.run_id);
    const claim = await runs.claimRun('test');
    await runs.finishRun(claim!.run.id, claim!.lease_epoch, 'succeeded');
    const requeued = await runs.getRun(actor(), created.run_id!);
    expect(requeued.status).toBe('queued');
    const next = await runs.claimRun('test');
    await runs.finishRun(next!.run.id, next!.lease_epoch, 'succeeded');
  });
  it('waiting_user补充保存并恢复原run，等待不占槽', async () => {
    const created = await newThread();
    const claim = await runs.claimRun('test');
    await runs.saveCheckpoint(
      claim!.run.id,
      claim!.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_user',
        pending_input_schema: { date: 'YYYY-MM-DD' },
      }),
    );
    const snapshot = await assistant.snapshot(actor(), created.thread.id);
    const accepted = await assistant.acceptMessage(
      actor(),
      created.thread.id,
      {
        ...message('出发日期是下周一'),
        expected_version: snapshot.thread.version,
      },
      randomUUID(),
    );
    expect(accepted.run_id).toBe(created.run_id);
    expect((await runs.getRun(actor(), created.run_id!)).status).toBe('queued');
    const next = await runs.claimRun('test');
    await runs.finishRun(next!.run.id, next!.lease_epoch, 'succeeded');
  });
  it('assistant.message/card.upsert与run事件同事务投影，刷新恢复不重复卡片', async () => {
    const created = await newThread();
    const claim = await runs.claimRun('test');
    const ref = { type: 'expense_claim' as const, id: 'claim-1', version: 1 };
    await runs.appendEvent(
      created.run_id!,
      claim!.lease_epoch,
      'assistant.message',
      { id: 'final-card-test', text: '有 5 张待审报销。' },
    );
    const card = {
      id: randomUUID(),
      schema_version: 1 as const,
      type: 'todo_summary' as const,
      thread_id: created.thread.id,
      message_id: 'final-card-test',
      run_id: created.run_id,
      title: '待审概要',
      summary: '5张待审',
      snapshot_at: new Date().toISOString(),
      resource_refs: [ref],
      payload: {
        count: 5,
        total: { amount_minor: '554000', currency: 'CNY' },
        list_scope: 'current_approval_scope',
        source_as_of: new Date().toISOString(),
      },
      actions: [],
      revision: 1,
      stale: false,
    };
    await runs.appendEvent(
      created.run_id!,
      claim!.lease_epoch,
      'card.upsert',
      card,
    );
    await runs.appendEvent(created.run_id!, claim!.lease_epoch, 'card.upsert', {
      ...card,
      revision: 2,
      summary: '更新概要',
    });
    const snapshot = await assistant.snapshot(actor(), created.thread.id);
    expect(snapshot.cards).toHaveLength(1);
    expect(
      snapshot.messages.filter((m) => m.role === 'assistant'),
    ).toHaveLength(1);
    expect(snapshot.cards[0]).toMatchObject({
      revision: 2,
      summary: '更新概要',
    });
    currentVersion = 2;
    expect(await assistant.getCard(actor(), card.id)).toMatchObject({
      stale: true,
    });
    allowed = false;
    expect(await assistant.getCard(actor(), card.id)).toMatchObject({
      unavailable: true,
    });
    await expect(
      assistant.snapshot(actor('admin'), created.thread.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    allowed = true;
    currentVersion = 1;
    await runs.finishRun(created.run_id!, claim!.lease_epoch, 'succeeded');
  });
  it('invalid card schema回滚事件，模型HTML/任意确认token不能穿透payload', async () => {
    const created = await newThread();
    const claim = await runs.claimRun('test');
    const before = (await runs.getRun(actor(), created.run_id!)).last_seq;
    await expect(
      runs.appendEvent(created.run_id!, claim!.lease_epoch, 'card.upsert', {
        type: 'unknown',
        payload: { html: '<script>', confirmation_token: 'fake' },
      }),
    ).rejects.toThrow();
    expect((await runs.getRun(actor(), created.run_id!)).last_seq).toBe(before);
    await runs.finishRun(created.run_id!, claim!.lease_epoch, 'succeeded');
  });
});
