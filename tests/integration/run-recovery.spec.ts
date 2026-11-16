import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createDurableQueue } from '../../packages/jobs/src/queue.js';
import { createWorkerRunner } from '../../apps/worker/src/runner/index.js';
import type {
  AgentRuntimeAdapter,
  RuntimeHandle,
} from '../../packages/agent-runtime/src/adapter.js';

const database = createDatabase(loadConfig().databaseUrl);
const tenant = `runtime-test-${randomUUID()}`;
const actor = (user = 'user-a'): ActorContext => ({
  tenant_id: tenant,
  user_id: user,
  roles: ['employee'],
  department_ids: [],
  permissions: [],
  authz_version: 1,
  session_id: `session-${user}`,
  invocation_origin: 'interactive',
  delegation_id: null,
});
const freshActor = async (value: ActorContext) => value;
const runs = createRunService(database, { freshActor });
const enqueue = (user = 'user-a') =>
  runs.createRun(
    actor(user),
    { thread_id: randomUUID(), input_message_id: randomUUID() },
    randomUUID(),
  );
const leased = async () => {
  const claim = await runs.claimRun('test-worker');
  expect(claim).not.toBeNull();
  return claim!;
};
const drain = async () => {
  for (;;) {
    const next = await runs.claimRun('test-worker');
    if (!next) break;
    await runs.finishRun(next.run.id, next.lease_epoch, 'succeeded');
  }
};
afterAll(async () => {
  await database.pool.query('DELETE FROM model_slots WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM durable_jobs WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM runtime_fairness WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.close();
});
describe('真实 PostgreSQL 可靠任务与恢复', () => {
  it('领域异步等待保留同run并释放租约，完成按job/generation去重且取消不复活', async () => {
    const run = await enqueue('domain-wait-user');
    const claim = await leased();
    const checkpoint = await runs.saveCheckpoint(
      run.id,
      claim.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_domain_job',
        waiting_job_ref: {
          id: 'domain-task-a',
          kind: 'preaudit',
          generation: 2,
        },
      }),
    );
    const waiting = await runs.getRun(actor('domain-wait-user'), run.id);
    expect(waiting.status).toBe('running');
    expect(waiting.runtime_active).toBe(false);
    await expect(runs.assertLease(run.id, claim.lease_epoch)).rejects.toThrow();
    expect(
      await runs.completeDomainJob(
        actor('domain-wait-user'),
        run.id,
        checkpoint,
        { id: 'domain-task-a', generation: 1 },
      ),
    ).toBe(false);
    expect(
      await runs.completeDomainJob(
        actor('domain-wait-user'),
        run.id,
        checkpoint,
        { id: 'domain-task-a', generation: 2 },
      ),
    ).toBe(true);
    expect(
      await runs.completeDomainJob(
        actor('domain-wait-user'),
        run.id,
        checkpoint,
        { id: 'domain-task-a', generation: 2 },
      ),
    ).toBe(false);
    const next = await leased();
    expect(next.run.id).toBe(run.id);
    await runs.finishRun(run.id, next.lease_epoch, 'succeeded');
    const cancelled = await enqueue('domain-cancel-user');
    const other = await leased();
    const point = await runs.saveCheckpoint(
      cancelled.id,
      other.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_domain_job',
        waiting_job_ref: { id: 'late-domain', kind: 'preaudit', generation: 1 },
      }),
    );
    const state = await runs.getRun(actor('domain-cancel-user'), cancelled.id);
    await runs.cancelRun(
      actor('domain-cancel-user'),
      cancelled.id,
      { expected_version: state.version, reason: '停止' },
      randomUUID(),
    );
    expect(
      await runs.completeDomainJob(
        actor('domain-cancel-user'),
        cancelled.id,
        point,
        { id: 'late-domain', generation: 1 },
      ),
    ).toBe(false);
    expect(
      (await runs.getRun(actor('domain-cancel-user'), cancelled.id)).status,
    ).toBe('cancelled');
  });
  it('runner保存确认检查点后退出并释放槽，可信确认结果续接同run', async () => {
    const trusted = createRunService(database, {
      freshActor,
      authorizeResume: async (_actor, _run, checkpoint) => {
        expect(checkpoint.pending_confirmation_id).toBe('server-confirmed');
      },
    });
    const run = await trusted.createRun(
      actor('confirm-runner'),
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    let disposed = 0;
    const runtime: AgentRuntimeAdapter = {
      start: async () => ({
        runtime_instance_id: 'test-only',
        runtime_session_id: 'test-session',
        events: (async function* () {
          yield {
            type: 'checkpoint' as const,
            checkpoint: CheckpointSchema.parse({
              stage: 'waiting_confirmation',
              pending_confirmation_id: 'server-confirmed',
            }),
          };
          yield {
            type: 'response_complete' as const,
            text: '不得发布的旧回答',
            message_id: 'forbidden-success',
          };
        })(),
      }),
      continue: async () => ({
        runtime_instance_id: 'test-resumed',
        runtime_session_id: 'test-session-2',
        events: (async function* () {
          yield {
            type: 'response_complete' as const,
            text: '已读取可信业务回执。',
            message_id: 'trusted-final',
          };
          yield { type: 'idle' as const };
        })(),
      }),
      stop: async () => ({
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'uncertain',
      }),
      dispose: async () => {
        disposed++;
      },
    };
    const runner = createWorkerRunner({
      runs: trusted,
      runtime,
      freshActor,
      workerId: 'confirmation-test-worker',
    });
    await runner.tick();
    await runner.waitForIdle();
    const waiting = await trusted.getRun(actor('confirm-runner'), run.id);
    expect(waiting.status).toBe('waiting_confirmation');
    expect(waiting.runtime_active).toBe(false);
    expect(disposed).toBe(1);
    expect(
      (await trusted.events(actor('confirm-runner'), run.id)).some(
        (e) => e.type === 'assistant.message',
      ),
    ).toBe(false);
    await trusted.resumeRun(
      actor('confirm-runner'),
      run.id,
      {
        expected_version: waiting.version,
        checkpoint_id: waiting.checkpoint_id!,
      },
      randomUUID(),
    );
    await runner.tick();
    await runner.waitForIdle();
    expect((await trusted.getRun(actor('confirm-runner'), run.id)).status).toBe(
      'succeeded',
    );
    expect(
      (await trusted.events(actor('confirm-runner'), run.id)).filter(
        (e) => e.type === 'assistant.message',
      ),
    ).toHaveLength(1);
    await runner.stop();
  });
  it('同消息与Idempotency-Key双重去重，changed payload明确冲突', async () => {
    const input = { thread_id: randomUUID(), input_message_id: randomUUID() };
    const key = randomUUID();
    const [a, b] = await Promise.all([
      runs.createRun(actor(), input, key),
      runs.createRun(actor(), input, key),
    ]);
    expect(a.id).toBe(b.id);
    expect((await runs.createRun(actor(), input, randomUUID())).id).toBe(a.id);
    await expect(
      runs.createRun(
        actor(),
        { ...input, input_message_id: randomUUID() },
        key,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      runs.createRun(
        actor(),
        { ...input, input_message_id: randomUUID() },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const result = await database.pool.query(
      'SELECT count(*)::int n FROM run_jobs WHERE run_id=$1',
      [a.id],
    );
    expect(result.rows[0].n).toBe(1);
    await drain();
  });
  it('two_workers_one_owner：并发领取同一run只产生一个执行者', async () => {
    const run = await enqueue();
    const [a, b] = await Promise.all([
      runs.claimRun('worker-a'),
      runs.claimRun('worker-b'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const owner = (a ?? b)!;
    expect(owner.run.id).toBe(run.id);
    await runs.finishRun(run.id, owner.lease_epoch, 'succeeded');
  });
  it('old_epoch_denied：Worker重启只读任务可接管，旧epoch不能再派发工具', async () => {
    const run = await enqueue();
    const first = await leased();
    await database.pool.query(
      "UPDATE run_leases SET lease_until=now()-interval '1 second' WHERE run_id=$1",
      [run.id],
    );
    expect(await runs.recoverExpired()).toBe(1);
    const next = await leased();
    expect(next.run.id).toBe(run.id);
    expect(next.lease_epoch).toBeGreaterThan(first.lease_epoch);
    await expect(
      runs.assertLease(run.id, first.lease_epoch),
    ).rejects.toMatchObject({ details: { reason: 'LEASE_LOST' } });
    const tool = {
      call_id: randomUUID(),
      name: 'finance.health.read',
      version: '1.0.0',
      arguments: {},
      effect: 'read' as const,
    };
    await expect(
      runs.beginTool(run.id, first.lease_epoch, tool),
    ).rejects.toThrow();
    await runs.beginTool(run.id, next.lease_epoch, tool);
    await runs.completeTool(run.id, next.lease_epoch, tool.call_id, {
      status: 'ok',
      data: { healthy: true },
      evidence_refs: [],
      action_id: null,
      error_code: null,
    });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM runtime_tool_calls WHERE run_id=$1',
          [run.id],
        )
      ).rows[0].n,
    ).toBe(1);
    await runs.finishRun(run.id, next.lease_epoch, 'succeeded');
  });
  it('等待checkpoint释放槽，续接检查版本并拒绝相信客户端已确认', async () => {
    const run = await enqueue();
    const claim = await leased();
    const point = await runs.saveCheckpoint(
      run.id,
      claim.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_confirmation',
        pending_confirmation_id: 'confirm-from-action-service',
      }),
    );
    const waiting = await runs.getRun(actor(), run.id);
    expect(waiting.status).toBe('waiting_confirmation');
    expect(waiting.runtime_active).toBe(false);
    await expect(runs.assertLease(run.id, claim.lease_epoch)).rejects.toThrow();
    await expect(
      runs.resumeRun(
        actor(),
        run.id,
        {
          expected_version: waiting.version,
          checkpoint_id: point,
          input: { status: 'succeeded' },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    await runs.cancelRun(
      actor(),
      run.id,
      { expected_version: waiting.version, reason: '停止' },
      randomUUID(),
    );
  });
  it('cancel_does_not_kill_other_user：取消只停止目标，跨用户事件与取消均404', async () => {
    const a = await enqueue('cancel-a');
    const b = await enqueue('cancel-b');
    const one = await leased();
    const two = await leased();
    const own = one.run.id === a.id ? one : two;
    const other = one.run.id === b.id ? one : two;
    await expect(runs.getRun(actor('cancel-a'), b.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(runs.events(actor('cancel-a'), b.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await runs.cancelRun(
      actor('cancel-a'),
      a.id,
      { expected_version: own.run.version, reason: '用户停止' },
      randomUUID(),
    );
    await expect(runs.assertLease(a.id, own.lease_epoch)).rejects.toThrow();
    await expect(
      runs.assertLease(b.id, other.lease_epoch),
    ).resolves.toBeUndefined();
    await runs.finishRun(a.id, own.lease_epoch, 'cancelled');
    await runs.finishRun(b.id, other.lease_epoch, 'succeeded');
    expect((await runs.getRun(actor('cancel-a'), a.id)).status).toBe(
      'cancelled',
    );
    expect((await runs.getRun(actor('cancel-b'), b.id)).status).toBe(
      'succeeded',
    );
  });
  it('user_two_slots与公平排队：同人第三个排队，其他用户可以领取', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await enqueue('slots-a')).id);
    const other = await enqueue('slots-b');
    const claims = [];
    for (let i = 0; i < 3; i++) claims.push(await leased());
    expect(claims.filter((c) => c.run.owner_id === 'slots-a')).toHaveLength(2);
    expect(claims.some((c) => c.run.id === other.id)).toBe(true);
    expect(await runs.claimRun('fourth')).toBeNull();
    for (const claim of claims)
      await runs.finishRun(claim.run.id, claim.lease_epoch, 'succeeded');
    await drain();
  });
  it('每用户10个未结束任务到限429；领域作业独立且有租约fencing', async () => {
    const created = [];
    for (let i = 0; i < 10; i++) created.push(await enqueue('quota-user'));
    await expect(enqueue('quota-user')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    const queue = createDurableQueue(database);
    const input = {
      tenant_id: tenant,
      owner_module: 'knowledge',
      kind: 'import',
      payload_ref: 'policy:fixture',
      dedupe_key: randomUUID(),
    };
    const first = await queue.enqueue(input);
    expect((await queue.enqueue(input)).id).toBe(first.id);
    const job = await queue.claim('domain-worker', ['import']);
    expect(job?.id).toBe(first.id);
    await expect(
      queue.finish(
        first.id,
        'domain-worker',
        job!.lease_epoch - 1,
        'succeeded',
      ),
    ).rejects.toThrow();
    await queue.finish(
      first.id,
      'domain-worker',
      job!.lease_epoch,
      'succeeded',
    );
    for (const run of created)
      await runs.cancelRun(
        actor('quota-user'),
        run.id,
        { expected_version: run.version, reason: '清理' },
        randomUUID(),
      );
  });
  it('SSE断线重放严格大于seq，过期返回快照入口且最终消息保留', async () => {
    const run = await enqueue();
    const claim = await leased();
    const first = await runs.appendEvent(
      run.id,
      claim.lease_epoch,
      'assistant.delta',
      { text: '片段' },
    );
    const message = await runs.appendEvent(
      run.id,
      claim.lease_epoch,
      'assistant.message',
      { id: 'stable-final', text: '持久结果' },
    );
    const events = await runs.events(actor(), run.id, first.seq);
    expect(events.map((e) => e.seq)).toEqual([message.seq]);
    const reopened = createDatabase(loadConfig().databaseUrl);
    try {
      const copy = createRunService(reopened, { freshActor });
      expect(
        (await copy.events(actor(), run.id, first.seq))[0]?.payload,
      ).toEqual({ id: 'stable-final', text: '持久结果' });
    } finally {
      await reopened.close();
    }
    await database.pool.query(
      "UPDATE run_events SET occurred_at='1960-01-01' WHERE run_id=$1 AND type='assistant.delta'",
      [run.id],
    );
    await runs.pruneEvents(new Date('1970-01-01'));
    await expect(runs.events(actor(), run.id, 0)).rejects.toMatchObject({
      code: 'REVALIDATION_REQUIRED',
      details: {
        reason: 'EVENT_CURSOR_EXPIRED',
        snapshot_url: `/api/v1/runs/${run.id}/snapshot`,
      },
    });
    expect(
      (await runs.snapshot(actor(), run.id)).events.some(
        (e) => e.type === 'assistant.message',
      ),
    ).toBe(true);
    await runs.finishRun(run.id, claim.lease_epoch, 'succeeded');
  });
  it('未知写入只进入待核实，不被取消或重启当成失败且不重发写入', async () => {
    const run = await enqueue('unknown-user');
    const claim = await leased();
    const callId = randomUUID();
    await runs.beginTool(run.id, claim.lease_epoch, {
      call_id: callId,
      name: 'internal.action.execute',
      version: '1',
      arguments: { id: 'action-fixture' },
      effect: 'write',
    });
    await runs.completeTool(run.id, claim.lease_epoch, callId, {
      status: 'unknown',
      data: null,
      evidence_refs: [],
      action_id: 'action-fixture',
      error_code: 'OUTCOME_UNKNOWN',
    });
    await runs.finishRun(run.id, claim.lease_epoch, 'succeeded');
    const state = await runs.getRun(actor('unknown-user'), run.id);
    expect(state.status).toBe('reconciling');
    expect(await runs.claimRun('should-not-replay')).toBeNull();
    await runs.cancelRun(
      actor('unknown-user'),
      run.id,
      { expected_version: state.version, reason: '停止后续' },
      randomUUID(),
    );
    expect((await runs.getRun(actor('unknown-user'), run.id)).status).toBe(
      'reconciling',
    );
  });
  it('工具预算和call_id去重：同一完成调用复用结果，超预算前拒绝派发', async () => {
    const limited = createRunService(database, {
      freshActor,
      budgets: { tool_calls: 1 },
    });
    const run = await limited.createRun(
      actor('budget-user'),
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    const claim = await limited.claimRun('budget-worker');
    const input = {
      call_id: randomUUID(),
      name: 'finance.health.read',
      version: '1',
      arguments: {},
      effect: 'read' as const,
    };
    await limited.beginTool(run.id, claim!.lease_epoch, input);
    const result = {
      status: 'ok' as const,
      data: { checked: true },
      evidence_refs: [],
      action_id: null,
      error_code: null,
    };
    await limited.completeTool(
      run.id,
      claim!.lease_epoch,
      input.call_id,
      result,
    );
    expect(
      (await limited.beginTool(run.id, claim!.lease_epoch, input)).cached,
    ).toEqual(result);
    await expect(
      limited.beginTool(run.id, claim!.lease_epoch, {
        ...input,
        call_id: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await limited.finishRun(run.id, claim!.lease_epoch, 'succeeded');
  });
  it('真实已发生用量超限仍落账，下一次模型预留被拒绝且不重置累计预算', async () => {
    const limited = createRunService(database, {
      freshActor,
      budgets: { model_calls: 2, output_tokens: 5, active_ms: 1000 },
    });
    const owner = actor('actual-usage-user');
    const run = await limited.createRun(
      owner,
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    const claim = await limited.claimRun('actual-usage-worker');
    expect(claim?.run.id).toBe(run.id);
    await limited.recordUsage(run.id, claim!.lease_epoch, { model_calls: 1 });
    await expect(
      limited.recordUsage(run.id, claim!.lease_epoch, {
        output_tokens: 6,
        elapsed_ms: 1100,
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await limited.getRun(owner, run.id)).usage).toMatchObject({
      model_calls: 1,
      output_tokens: 6,
      elapsed_ms: 1100,
    });
    await expect(
      limited.recordUsage(run.id, claim!.lease_epoch, { model_calls: 1 }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await limited.getRun(owner, run.id)).usage.model_calls).toBe(1);
    await limited.finishRun(
      run.id,
      claim!.lease_epoch,
      'failed',
      'RATE_LIMITED',
    );
  });
  it('模型缺配置时Worker明确失败，不返回智能成功或固定回复', async () => {
    const run = await enqueue('unconfigured-user');
    const runtime: AgentRuntimeAdapter = {
      start: async () => {
        throw new Error('not configured');
      },
      continue: async () => {
        throw new Error('not configured');
      },
      stop: async () => ({
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'uncertain',
      }),
      dispose: async (_handle: RuntimeHandle) => {},
    };
    const runner = createWorkerRunner({
      runs,
      runtime,
      freshActor,
      workerId: 'unconfigured-worker',
    });
    await runner.tick();
    await runner.waitForIdle();
    const failed = await runs.getRun(actor('unconfigured-user'), run.id);
    expect(failed.status).toBe('failed');
    expect(failed.error_code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(
      (await runs.events(actor('unconfigured-user'), run.id)).some(
        (e) => e.type === 'assistant.message',
      ),
    ).toBe(false);
    await runner.stop();
  });
});
