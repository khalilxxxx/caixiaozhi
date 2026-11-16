import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts';
import type {
  AgentRuntimeAdapter,
  RuntimeMaterial,
} from '@caixiaozhi/agent-runtime';
import { createModelSlotService } from '@caixiaozhi/agent-runtime/model-slots';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createControlledDshGenerator } from '../../packages/application/src/dsh-generation.js';
import {
  assertExpectedFacts,
  assertSkillManageScope,
} from '../../packages/application/src/skill-validation.js';
const db = createDatabase(loadConfig().databaseUrl),
  tenant = `generation-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'u-test',
  roles: ['finance'],
  department_ids: ['sales'],
  permissions: ['skill.manage'],
  authz_version: 1,
  session_id: 's',
  invocation_origin: 'interactive',
  delegation_id: null,
};
const schema = {
  type: 'object',
  properties: { answer: { type: 'string', maxLength: 100 } },
  required: ['answer'],
  additionalProperties: false,
};
const adapter = (
  material: RuntimeMaterial,
  answer: unknown,
): AgentRuntimeAdapter => ({
  async start() {
    await material.beforeModelCall?.();
    return {
      runtime_instance_id: 'deterministic-runtime-adapter',
      runtime_session_id: 'deterministic-session',
      events: (async function* () {
        yield {
          type: 'response_complete' as const,
          text: JSON.stringify(answer),
          message_id: 'fixture-message',
        };
        yield { type: 'idle' as const };
      })(),
    };
  },
  async continue() {
    throw new Error('未使用');
  },
  async stop() {
    return {
      process_stopped: true,
      pending_call_ids: [],
      persistence_state: 'flushed',
    };
  },
  async dispose() {},
});
describe('受控dsh生成的持久任务与发布范围', () => {
  afterAll(async () => {
    for (const table of [
      'model_generation_events',
      'model_generation_tasks',
      'model_slots',
      'durable_jobs',
    ])
      await db.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    await db.close();
  });
  it('财务角色和组成员不推导发布权，只有显式scope生效', async () => {
    await expect(
      assertSkillManageScope(actor, { scope: 'tenant' }, async () => ({
        operations_ids: [],
        named_resource_ids: [],
      })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      assertSkillManageScope(
        actor,
        { scope: 'group', group_ids: ['finance'] },
        async () => ({ operations_ids: [], named_resource_ids: ['other'] }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      assertSkillManageScope(actor, { scope: 'tenant' }, async () => ({
        operations_ids: ['skill-share:tenant'],
        named_resource_ids: [],
      })),
    ).resolves.toBeUndefined();
  });
  it('结构化事实不允许改变金额和未知布尔，解释措辞可不同', () => {
    expect(() =>
      assertExpectedFacts(
        {
          answer: '措辞甲',
          money: { amount_minor: '590000', currency: 'CNY' },
          needs_clarification: false,
        },
        {
          answer: '措辞乙',
          money: { amount_minor: '590000', currency: 'CNY' },
          needs_clarification: false,
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertExpectedFacts(
        { money: { amount_minor: '590000' } },
        { money: { amount_minor: '600000' } },
      ),
    ).toThrow();
    expect(() =>
      assertExpectedFacts(
        { needs_clarification: true },
        { needs_clarification: false },
      ),
    ).toThrow();
  });
  it('模型缺失真实blocked并保留任务，绝不返回假生成', async () => {
    const service = createControlledDshGenerator({
      database: db,
      freshActor: async (a) => a,
      assertResourceAccess: async () => {},
      modelConfigured: false,
    });
    await expect(
      service.controlledDshJson({
        actor,
        operation: 'knowledge.answer',
        prompt: '测试制度来源',
        schema,
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: { status: 'blocked' },
    });
    const result = await db.db.execute(
      sql`SELECT state,result FROM model_generation_tasks WHERE tenant_id=${tenant}`,
    );
    expect(result.rows[0]).toEqual({ state: 'blocked', result: null });
  });
  it('确定性runtime端口检验schema和跨重试幂等，输出审计无原始输入', async () => {
    const service = createControlledDshGenerator({
      database: db,
      freshActor: async (a) => a,
      assertResourceAccess: async () => {},
      modelConfigured: true,
      runtimeFactory: (m) => adapter(m, { answer: '根据授权材料生成的候选' }),
    });
    const input = {
        actor,
        operation: 'knowledge.answer' as const,
        prompt: '包含私有材料的测试输入',
        schema,
        idempotency_key: randomUUID(),
      },
      a = await service.controlledDshJson(input),
      b = await service.controlledDshJson(input);
    expect(a.task_id).toBe(b.task_id);
    expect(a.data).toEqual({ answer: '根据授权材料生成的候选' });
    await expect(
      service.controlledDshJson({ ...input, prompt: '改变输入' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const events = await db.db.execute(
      sql`SELECT details FROM model_generation_events WHERE tenant_id=${tenant}`,
    );
    expect(JSON.stringify(events.rows)).not.toContain('包含私有材料');
    const invalid = createControlledDshGenerator({
      database: db,
      freshActor: async (a) => a,
      assertResourceAccess: async () => {},
      modelConfigured: true,
      runtimeFactory: (m) => adapter(m, { answer: 100 }),
    });
    await expect(
      invalid.controlledDshJson({ ...input, idempotency_key: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { status: 'failed' },
    });
  });
  it('公共模型槽满时持久排队且不启动runtime，释放后按原任务继续', async () => {
    const slots = createModelSlotService(db, { userSlots: 1 }),
      held = await slots.acquire({
        tenant_id: tenant,
        owner_id: actor.user_id,
        kind: 'agent_run',
        reference_id: 'occupied',
        owner_epoch: 1,
        lease_owner: 'occupied-worker',
      });
    expect(held).toBeTruthy();
    let starts = 0;
    const generator = createControlledDshGenerator({
      database: db,
      modelSlots: slots,
      freshActor: async (a) => a,
      assertResourceAccess: async () => {},
      modelConfigured: true,
      runtimeFactory: (m) => {
        const base = adapter(m, { answer: '真实槽位释放后的测试候选' });
        return {
          ...base,
          start: async (input) => {
            starts++;
            return base.start(input);
          },
        };
      },
    });
    const input = {
      actor,
      operation: 'knowledge.answer' as const,
      prompt: '模型并发验证',
      schema,
      idempotency_key: randomUUID(),
    };
    await expect(generator.controlledDshJson(input)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: { status: 'queued' },
    });
    expect(starts).toBe(0);
    const row = (
      await db.db.execute(
        sql`SELECT id,job_id,state FROM model_generation_tasks WHERE tenant_id=${tenant} AND idempotency_key=${input.idempotency_key}`,
      )
    ).rows[0]!;
    expect(row.state).toBe('queued');
    await slots.release(held!);
    await db.db.execute(
      sql`UPDATE durable_jobs SET ready_at=now() WHERE id=${row.job_id as string}`,
    );
    await generator.processJob(String(row.job_id));
    expect(starts).toBe(1);
    expect((await generator.getTask(actor, String(row.id))).state).toBe(
      'succeeded',
    );
  });
});
