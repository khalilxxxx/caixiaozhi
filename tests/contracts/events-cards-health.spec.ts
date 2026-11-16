import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentCardEnvelopeSchema,
  AgentCardSchema,
  HealthDataSchema,
  HealthResponseSchema,
  SseEventSchema,
  createAgentCardSchema,
} from '@caixiaozhi/contracts';

const card = {
  id: 'card-1',
  schema_version: 1,
  type: 'document_summary',
  thread_id: 'thread-1',
  message_id: 'message-1',
  run_id: 'run-1',
  title: '报销单概要',
  summary: '交通费报销。',
  snapshot_at: '2026-11-05T01:00:00Z',
  resource_refs: [{ type: 'expense_claim', id: 'clm-001', version: 1 }],
  payload: {
    document_id: 'clm-001',
    amount: { amount_minor: '68000', currency: 'CNY' },
  },
  actions: [
    {
      id: 'open-1',
      label: '查看报销单',
      kind: 'open_drawer',
      target: 'expense_claim/clm-001',
    },
  ],
  revision: 1,
  stale: false,
};

describe('SSE 仅实现设计既定的事件信封', () => {
  it.each([
    'run.status',
    'assistant.delta',
    'assistant.message',
    'tool.started',
    'tool.completed',
    'card.upsert',
    'confirmation.required',
    'usage.updated',
    'run.error',
  ])('接受固定事件类型 %s', (type) => {
    const event = {
      run_id: 'run-1',
      seq: 1,
      type,
      occurred_at: '2026-11-05T01:00:00Z',
      payload: { domain: 'deferred' },
    };
    expect(SseEventSchema.parse(event)).toEqual(event);
  });

  it('拒绝未知事件类型、非正整数序号及非 UTC 时间', () => {
    const event = {
      run_id: 'run-1',
      seq: 1,
      type: 'run.status',
      occurred_at: '2026-11-05T01:00:00Z',
      payload: {},
    };
    expect(
      SseEventSchema.safeParse({ ...event, type: 'outbox.created' }).success,
    ).toBe(false);
    expect(SseEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(SseEventSchema.safeParse({ ...event, seq: 1.5 }).success).toBe(
      false,
    );
    expect(
      SseEventSchema.safeParse({
        ...event,
        occurred_at: '2026-11-05T09:00:00+08:00',
      }).success,
    ).toBe(false);
    expect(
      SseEventSchema.safeParse({ ...event, tenant_id: 't-demo' }).success,
    ).toBe(false);
    const { payload: _payload, ...missingPayload } = event;
    expect(SseEventSchema.safeParse(missingPayload).success).toBe(false);
  });
});

describe('AgentCard 为后续领域实现保留严格 payload 注册入口', () => {
  const registered = createAgentCardSchema({
    document_summary: z.strictObject({
      document_id: z.string().min(1),
      amount: z.strictObject({
        amount_minor: z.string().regex(/^[1-9]\d*$/),
        currency: z.literal('CNY'),
      }),
    }),
  });

  it('信封解析不会宣称任意 payload 已完成，默认注册表拒绝卡片', () => {
    expect(AgentCardEnvelopeSchema.parse(card)).toEqual(card);
    expect(AgentCardSchema.safeParse(card).success).toBe(false);
    expect(createAgentCardSchema({}).safeParse(card).success).toBe(false);
  });

  it('仅接受注册类型及其严格 payload', () => {
    expect(registered.parse(card)).toEqual(card);
    expect(
      registered.safeParse({ ...card, type: 'todo_summary' }).success,
    ).toBe(false);
    expect(registered.safeParse({ ...card, type: 'custom_card' }).success).toBe(
      false,
    );
    expect(registered.safeParse({ ...card, payload: {} }).success).toBe(false);
    expect(
      registered.safeParse({
        ...card,
        payload: { ...card.payload, hidden: true },
      }).success,
    ).toBe(false);
    expect(
      registered.safeParse({
        ...card,
        payload: {
          ...card.payload,
          amount: { ...card.payload.amount, hidden: true },
        },
      }).success,
    ).toBe(false);
  });

  it('工厂将 payload 根对象设为严格边界', () => {
    const schema = createAgentCardSchema({
      document_summary: z.object({ document_id: z.string() }),
    });
    expect(
      schema.safeParse({
        ...card,
        payload: { document_id: 'clm-001', hidden: true },
      }).success,
    ).toBe(false);
  });

  it('拒绝信封、动作和资源引用中的额外字段', () => {
    expect(registered.safeParse({ ...card, html: '<script />' }).success).toBe(
      false,
    );
    expect(
      registered.safeParse({
        ...card,
        actions: [{ ...card.actions[0], onclick: 'run()' }],
      }).success,
    ).toBe(false);
    expect(
      registered.safeParse({
        ...card,
        resource_refs: [{ ...card.resource_refs[0], hidden: true }],
      }).success,
    ).toBe(false);
    expect(registered.safeParse({ ...card, schema_version: 2 }).success).toBe(
      false,
    );
    expect(registered.safeParse({ ...card, revision: 0 }).success).toBe(false);
  });
});

describe('T01 技术健康检查共用统一响应协议', () => {
  it.each(['alive', 'ready', 'not_ready'])('接受 API 健康状态 %s', (status) => {
    expect(HealthDataSchema.safeParse({ service: 'api', status }).success).toBe(
      true,
    );
  });

  it('接受数据库和存储依赖状态', () => {
    const response = {
      data: {
        service: 'api',
        status: 'not_ready',
        dependencies: { database: 'unavailable', storage: 'ready' },
      },
      meta: {
        request_id: 'req-1',
        trace_id: 'trace-1',
        server_time: '2026-11-05T01:00:00Z',
        data_mode: 'demo',
      },
    };
    expect(HealthResponseSchema.parse(response)).toEqual(response);
  });

  it('拒绝附加服务、遗漏依赖状态及未定义的响应字段', () => {
    expect(
      HealthDataSchema.safeParse({ service: 'worker', status: 'ready' })
        .success,
    ).toBe(false);
    expect(
      HealthDataSchema.safeParse({ service: 'api', status: 'ok' }).success,
    ).toBe(false);
    expect(
      HealthDataSchema.safeParse({
        service: 'api',
        status: 'ready',
        dependencies: { database: 'ready' },
      }).success,
    ).toBe(false);
    expect(
      HealthDataSchema.safeParse({
        service: 'api',
        status: 'ready',
        dependencies: { database: 'ready', storage: 'ready', redis: 'ready' },
      }).success,
    ).toBe(false);
    expect(
      HealthDataSchema.safeParse({
        service: 'api',
        status: 'ready',
        uptime: 100,
      }).success,
    ).toBe(false);
  });
});
