import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import {
  createModelSlotService,
  type ModelSlotInput,
} from '../../packages/agent-runtime/src/model-slots.js';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createWorkerRunner } from '../../apps/worker/src/runner/index.js';
import type { AgentRuntimeAdapter } from '../../packages/agent-runtime/src/adapter.js';
const database = createDatabase(loadConfig().databaseUrl),
  tenant = `model-slots-${randomUUID()}`,
  slots = createModelSlotService(database);
const input = (
  kind: ModelSlotInput['kind'],
  owner = 'owner',
  reference = randomUUID(),
): ModelSlotInput => ({
  tenant_id: tenant,
  owner_id: owner,
  kind,
  reference_id: reference,
  owner_epoch: 1,
  lease_owner: 'model-test-worker',
});
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'busy-user',
  roles: ['employee'],
  permissions: [],
  department_ids: [],
  authz_version: 1,
  session_id: 'fixture',
  invocation_origin: 'interactive',
  delegation_id: null,
};
afterAll(async () => {
  await database.pool.query('DELETE FROM model_slots WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.pool.query('DELETE FROM runtime_fairness WHERE tenant_id=$1', [
    tenant,
  ]);
  await database.close();
});
describe('实际PostgreSQL公共模型执行槽', () => {
  it('Agent/结构化生成/Skill验证共享用户2槽，相同run/epoch不会重复计数', async () => {
    const a = input('agent_run'),
      b = input('generation');
    const one = await slots.acquire(a),
      two = await slots.acquire(b);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect((await slots.acquire(a))?.id).toBe(one?.id);
    expect(
      await slots.acquire({ ...a, lease_owner: 'other-worker' }),
    ).toBeNull();
    expect(await slots.acquire(input('skill_validation'))).toBeNull();
    await slots.release(two!);
    const three = await slots.acquire(input('skill_validation'));
    expect(three).not.toBeNull();
    await slots.release(one!);
    await slots.release(three!);
  });
  it('租户20槽为所有模型路径总和，超额排队，不影响其他租户', async () => {
    const leases = [];
    for (let i = 0; i < 20; i++) {
      const lease = await slots.acquire(
        input(
          i % 2 ? 'generation' : 'agent_run',
          `capacity-user-${Math.floor(i / 2)}`,
        ),
      );
      expect(lease).not.toBeNull();
      leases.push(lease!);
    }
    expect(
      await slots.acquire(input('skill_validation', 'twenty-first')),
    ).toBeNull();
    const isolated = await slots.acquire({
      ...input('generation', 'owner-other-tenant'),
      tenant_id: `${tenant}-isolated`,
    });
    expect(isolated).not.toBeNull();
    await slots.release(isolated!);
    await database.pool.query('DELETE FROM model_slots WHERE tenant_id=$1', [
      `${tenant}-isolated`,
    ]);
    for (const lease of leases) await slots.release(lease);
  });
  it('旧model slot epoch被拒绝，旧release不能释放新租约', async () => {
    const request = input('generation', 'fencing-user');
    const old = (await slots.acquire(request))!;
    await database.pool.query(
      "UPDATE model_slots SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old.id],
    );
    const next = (await slots.acquire({
      ...request,
      lease_owner: 'new-worker',
    }))!;
    expect(next.lease_epoch).toBeGreaterThan(old.lease_epoch);
    await expect(slots.assert(old)).rejects.toMatchObject({
      details: { reason: 'MODEL_SLOT_LEASE_LOST' },
    });
    await expect(slots.heartbeat(old)).rejects.toThrow();
    await slots.release(old);
    await expect(slots.assert(next)).resolves.toBeUndefined();
    await slots.release(next);
  });
  it('公共槽忙时Runner保留原run排队，释放后同run运行并归还槽', async () => {
    const one = (await slots.acquire(input('generation', 'busy-user')))!;
    const two = (await slots.acquire(input('skill_validation', 'busy-user')))!;
    const runs = createRunService(database, {
      freshActor: async (value) => value,
    });
    const run = await runs.createRun(
      actor,
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    let starts = 0;
    const start: AgentRuntimeAdapter['start'] = async (request) => {
      starts++;
      await request.assert_model_slot?.();
      return {
        runtime_instance_id: 'explicit-test-adapter',
        runtime_session_id: 'test-session',
        events: (async function* () {
          yield {
            type: 'response_complete' as const,
            text: '明确测试适配器结果',
            message_id: 'fixture-final',
          };
          yield { type: 'idle' as const };
        })(),
      };
    };
    const runtime: AgentRuntimeAdapter = {
      start,
      continue: start,
      dispose: async () => {},
      stop: async () => ({
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'uncertain',
      }),
    };
    const runner = createWorkerRunner({
      runs,
      runtime,
      modelSlots: slots,
      freshActor: async (value) => value,
    });
    await runner.tick();
    await runner.waitForIdle();
    expect(starts).toBe(0);
    expect(await runs.getRun(actor, run.id)).toMatchObject({
      status: 'queued',
      runtime_active: false,
      phase: 'waiting_model_slot',
    });
    await slots.release(one);
    await database.pool.query(
      'UPDATE run_jobs SET ready_at=now() WHERE run_id=$1',
      [run.id],
    );
    await runner.tick();
    await runner.waitForIdle();
    expect(starts).toBe(1);
    expect((await runs.getRun(actor, run.id)).status).toBe('succeeded');
    await slots.release(two);
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int n FROM model_slots WHERE tenant_id=$1 AND owner_id='busy-user' AND released_at IS NULL AND lease_until>now()",
          [tenant],
        )
      ).rows[0].n,
    ).toBe(0);
    await runner.stop();
  });
});
