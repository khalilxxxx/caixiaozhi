import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createWorkerRunner } from '../../apps/worker/src/runner/index.js';
import type {
  AgentRuntimeAdapter,
  RuntimeStart,
} from '../../packages/agent-runtime/src/adapter.js';
const database = createDatabase(loadConfig().databaseUrl),
  tenant = `active-budget-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'explicit-budget-owner',
  roles: ['employee'],
  permissions: [],
  department_ids: [],
  authz_version: 1,
  session_id: 'explicit-budget-session',
  invocation_origin: 'interactive',
  delegation_id: null,
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterAll(async () => {
  for (const table of [
    'model_slots',
    'agent_runs',
    'runtime_fairness',
    'outbox_events',
  ])
    await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
      tenant,
    ]);
  await database.close();
});
describe('真实PG活动预算在挂起和续接间累计', () => {
  it('Worker停止与运行退出并发时，共享结算事务只记录一次活动耗时', async () => {
    const runs = createRunService(database, {
      freshActor: async (value) => value,
    });
    const run = await runs.createRun(
      actor,
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        started = resolve;
      }),
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
    const deltas: number[] = [];
    const observed = {
      ...runs,
      recordUsage: async (...args: Parameters<typeof runs.recordUsage>) => {
        if (args[2].elapsed_ms !== undefined) deltas.push(args[2].elapsed_ms);
        return runs.recordUsage(...args);
      },
    };
    const start: AgentRuntimeAdapter['start'] = async () => ({
      runtime_instance_id: 'explicit-shutdown-budget-adapter',
      runtime_session_id: 'explicit-shutdown-session',
      events: (async function* () {
        started();
        await pending;
      })(),
    });
    const runtime: AgentRuntimeAdapter = {
      start,
      continue: start,
      dispose: async () => {},
      stop: async () => {
        release();
        return {
          process_stopped: true,
          pending_call_ids: [],
          persistence_state: 'flushed',
        };
      },
    };
    const runner = createWorkerRunner({
      runs: observed,
      runtime,
      freshActor: async (value) => value,
      claimScope: async () => ({ tenant_id: tenant }),
    });
    await runner.tick();
    await ready;
    await sleep(80);
    await runner.stop();
    const final = await runs.getRun(actor, run.id);
    expect(final.status).toBe('interrupted');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBeGreaterThanOrEqual(80);
    expect(final.usage.elapsed_ms).toBe(deltas[0]);
    const epoch = (
      await database.pool.query(
        'SELECT lease_epoch FROM run_leases WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].lease_epoch;
    await expect(
      runs.recordUsage(run.id, Number(epoch), { elapsed_ms: 1 }),
    ).rejects.toMatchObject({ details: { reason: 'LEASE_LOST' } });
  });
  it('确认/领域等待前每epoch只记一次实际活动时间，释放后拒绝旧owner，续接最终达限且token工具计数不变', async () => {
    const runs = createRunService(database, {
      freshActor: async (value) => value,
      authorizeResume: async () => {},
      budgets: { active_ms: 450 },
    });
    const run = await runs.createRun(
      actor,
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    );
    const accounting: Array<{ epoch: number; elapsed: number }> = [],
      inputs: RuntimeStart[] = [],
      suspended: Array<{ epoch: number; elapsed: number }> = [];
    const observed = {
      ...runs,
      recordUsage: async (...args: Parameters<typeof runs.recordUsage>) => {
        if (args[2].elapsed_ms !== undefined)
          accounting.push({ epoch: args[1], elapsed: args[2].elapsed_ms });
        return runs.recordUsage(...args);
      },
    };
    let starts = 0;
    const start: AgentRuntimeAdapter['start'] = async (input) => {
      inputs.push(input);
      const attempt = ++starts;
      const callId = randomUUID();
      await runs.beginTool(run.id, input.lease_epoch, {
        call_id: callId,
        name: 'explicit.test.read',
        version: '1',
        arguments: {},
        effect: 'read',
      });
      await runs.completeTool(run.id, input.lease_epoch, callId, {
        status: 'ok',
        data: { explicit_test: true },
        evidence_refs: [],
        action_id: null,
        error_code: null,
      });
      return {
        runtime_instance_id: 'explicit-active-budget-adapter',
        runtime_session_id: `explicit-session-${attempt}`,
        events: (async function* () {
          yield {
            type: 'usage' as const,
            model_calls: 1,
            input_tokens: 3,
            output_tokens: 2,
            cached_tokens: 0,
          };
          await sleep(80);
          yield {
            type: 'checkpoint' as const,
            checkpoint: CheckpointSchema.parse(
              attempt % 2
                ? {
                    stage: 'waiting_confirmation',
                    pending_confirmation_id: `explicit-confirmation-${attempt}`,
                  }
                : {
                    stage: 'waiting_domain_job',
                    waiting_job_ref: {
                      id: `explicit-domain-${attempt}`,
                      kind: 'explicit-test',
                      generation: 1,
                    },
                  },
            ),
          };
        })(),
      };
    };
    const runtime: AgentRuntimeAdapter = {
      start,
      continue: start,
      stop: async () => ({
        process_stopped: true,
        pending_call_ids: [],
        persistence_state: 'flushed',
      }),
      dispose: async () => {
        await sleep(10);
      },
    };
    const runner = createWorkerRunner({
      runs: observed,
      runtime,
      freshActor: async (value) => value,
      claimScope: async () => ({ tenant_id: tenant }),
      onSuspended: async (leased) => {
        const state = await runs.getRun(actor, run.id);
        suspended.push({
          epoch: leased.lease_epoch,
          elapsed: state.usage.elapsed_ms,
        });
        expect(state.usage.elapsed_ms).toBeGreaterThan(0);
        await expect(
          runs.recordUsage(run.id, leased.lease_epoch, { elapsed_ms: 1 }),
        ).rejects.toMatchObject({ details: { reason: 'LEASE_LOST' } });
      },
    });
    try {
      for (let n = 0; n < 8; n++) {
        const before = (await runs.getRun(actor, run.id)).usage.elapsed_ms;
        await runner.tick();
        await runner.waitForIdle();
        const state = await runs.getRun(actor, run.id);
        expect(state.usage.elapsed_ms).toBeGreaterThanOrEqual(before + 80);
        expect(inputs.at(-1)!.budgets.active_ms).toBe(450 - before);
        if (state.status === 'failed') break;
        expect(state.runtime_active).toBe(false);
        const saved = state.usage.elapsed_ms;
        await sleep(60);
        expect((await runs.getRun(actor, run.id)).usage.elapsed_ms).toBe(saved);
        const checkpoint = CheckpointSchema.parse(
          (
            await database.pool.query(
              'SELECT checkpoint FROM run_checkpoints WHERE id=$1',
              [state.checkpoint_id],
            )
          ).rows[0].checkpoint,
        );
        if (checkpoint.stage === 'waiting_domain_job')
          await runs.completeDomainJob(actor, run.id, state.checkpoint_id!, {
            id: checkpoint.waiting_job_ref!.id,
            generation: 1,
          });
        else
          await runs.resumeRun(
            actor,
            run.id,
            {
              expected_version: state.version,
              checkpoint_id: state.checkpoint_id!,
            },
            randomUUID(),
          );
      }
      const final = await runs.getRun(actor, run.id);
      expect(final).toMatchObject({
        status: 'failed',
        error_code: 'RATE_LIMITED',
        runtime_active: false,
      });
      expect(final.usage.elapsed_ms).toBeGreaterThan(450);
      expect(final.usage).toMatchObject({
        model_calls: starts,
        tool_calls: starts,
        input_tokens: starts * 3,
        output_tokens: starts * 2,
        cached_tokens: 0,
      });
      expect(new Set(accounting.map((item) => item.epoch)).size).toBe(starts);
      expect(accounting).toHaveLength(starts);
      expect(accounting.reduce((sum, item) => sum + item.elapsed, 0)).toBe(
        final.usage.elapsed_ms,
      );
      expect(suspended.length).toBe(starts - 1);
      expect(
        await runs.claimRun('must-not-resurrect', { tenant_id: tenant }),
      ).toBeNull();
    } finally {
      await runner.stop();
    }
  });
});
