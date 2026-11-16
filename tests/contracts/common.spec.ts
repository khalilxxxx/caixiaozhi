import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActionReceiptSchema,
  ActorContextSchema,
  ApiErrorSchema,
  BusinessObjectFieldsSchema,
  MoneySchema,
  PermissionSchema,
  ResourceRefSchema,
  RunStatusSchema,
  ToolRequestSchema,
  ToolResultSchema,
  UtcDateTimeSchema,
  createApiResponseSchema,
} from '@caixiaozhi/contracts';

const actor = {
  tenant_id: 't-demo',
  user_id: 'u-zhang',
  roles: ['manager'],
  department_ids: ['dept-sales'],
  permissions: ['expense.read.department', 'approval.decide'],
  authz_version: 1,
  session_id: 'session-1',
  invocation_origin: 'interactive',
  delegation_id: null,
};

const resource = { type: 'expense_claim', id: 'clm-001', version: 3 };
const receipt = {
  id: 'receipt-1',
  action_id: 'action-1',
  idempotency_key: 'approve-clm-001',
  outcome: 'succeeded',
  resource,
  external_receipt_id: null,
  occurred_at: '2026-11-05T01:00:00Z',
  data_mode: 'demo',
  error_code: null,
};
const meta = {
  request_id: 'req-1',
  trace_id: 'trace-1',
  server_time: '2026-11-05T01:00:00Z',
  data_mode: 'demo',
};

describe('Money 以规范十进制字符串保存人民币整数分', () => {
  it.each(['0', '1', '120000', '-1', '-120000', '90071992547409931234567890'])(
    '接受规范整数分 %s',
    (amount_minor) => {
      expect(MoneySchema.parse({ amount_minor, currency: 'CNY' })).toEqual({
        amount_minor,
        currency: 'CNY',
      });
    },
  );

  it.each([
    '',
    '00',
    '01',
    '-0',
    '-01',
    '+1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '１２',
  ])('%s 不属于规范整数分', (amount_minor) => {
    expect(
      MoneySchema.safeParse({ amount_minor, currency: 'CNY' }).success,
    ).toBe(false);
  });

  it.each([
    ['LF', '1\n'],
    ['CR', '1\r'],
    ['CRLF', '1\r\n'],
    ['行分隔符', '1\u2028'],
    ['段落分隔符', '1\u2029'],
  ])('拒绝整数分末尾的 %s', (_ending, amount_minor) => {
    expect(
      MoneySchema.safeParse({ amount_minor, currency: 'CNY' }).success,
    ).toBe(false);
  });

  it('拒绝其他币种、浮点数和额外字段', () => {
    expect(
      MoneySchema.safeParse({ amount_minor: '10', currency: 'USD' }).success,
    ).toBe(false);
    expect(
      MoneySchema.safeParse({ amount_minor: 10, currency: 'CNY' }).success,
    ).toBe(false);
    expect(
      MoneySchema.safeParse({
        amount_minor: '10',
        currency: 'CNY',
        amount: 0.1,
      }).success,
    ).toBe(false);
  });
});

describe('ActorContext 区分交互会话和已授权订阅', () => {
  it('接受交互上下文及具有订阅授权的后台上下文', () => {
    expect(ActorContextSchema.parse(actor)).toEqual(actor);
    const subscription = {
      ...actor,
      session_id: null,
      invocation_origin: 'subscription',
      delegation_id: 'delegation-1',
    };
    expect(ActorContextSchema.parse(subscription)).toEqual(subscription);
  });

  it.each([
    { session_id: null },
    { session_id: '' },
    {
      invocation_origin: 'subscription',
      session_id: 'session-1',
      delegation_id: 'delegation-1',
    },
    {
      invocation_origin: 'subscription',
      session_id: null,
      delegation_id: null,
    },
    { invocation_origin: 'subscription', session_id: null, delegation_id: '' },
    { roles: ['admin'] },
    { permissions: ['analytics.read'] },
    { authz_version: 0.5 },
    { tenant_id: '' },
    { is_admin: true },
  ])('拒绝不合法身份约束 %j', (change) => {
    expect(ActorContextSchema.safeParse({ ...actor, ...change }).success).toBe(
      false,
    );
  });

  it('权限仅使用设计中的固定名称', () => {
    expect(PermissionSchema.safeParse('analytics.query').success).toBe(true);
    expect(PermissionSchema.safeParse('demo.control').success).toBe(true);
    expect(PermissionSchema.safeParse('rules.company.manage').success).toBe(
      false,
    );
    expect(PermissionSchema.safeParse('demo.manage').success).toBe(false);
  });
});

describe('公共对象的标识、版本及 UTC 时间', () => {
  it('接受正整数版本、有效 UTC 时间及可选秒的小数部分', () => {
    expect(ResourceRefSchema.parse(resource)).toEqual(resource);
    expect(
      UtcDateTimeSchema.safeParse('2026-11-05T01:00:00.123Z').success,
    ).toBe(true);
    expect(
      BusinessObjectFieldsSchema.safeParse({
        id: 'id-1',
        tenant_id: 't-demo',
        version: 1,
        created_at: '2026-11-05T01:00:00Z',
        updated_at: '2026-11-05T01:00:00Z',
      }).success,
    ).toBe(true);
  });

  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法资源版本 %s',
    (version) => {
      expect(
        ResourceRefSchema.safeParse({ ...resource, version }).success,
      ).toBe(false);
    },
  );

  it.each([
    '2026-11-05',
    '2026-11-05T01:00:00',
    '2026-11-05T09:00:00+08:00',
    '2026-02-30T01:00:00Z',
    '2026-11-05T01:00Z',
  ])('拒绝非 RFC3339 UTC 秒级时间 %s', (timestamp) =>
    expect(UtcDateTimeSchema.safeParse(timestamp).success).toBe(false),
  );

  it.each([
    ['LF', '2026-11-05T01:00:00Z\n'],
    ['CR', '2026-11-05T01:00:00Z\r'],
    ['CRLF', '2026-11-05T01:00:00Z\r\n'],
    ['行分隔符', '2026-11-05T01:00:00Z\u2028'],
    ['段落分隔符', '2026-11-05T01:00:00Z\u2029'],
  ])('拒绝 UTC 时间末尾的 %s', (_ending, timestamp) => {
    expect(UtcDateTimeSchema.safeParse(timestamp).success).toBe(false);
  });

  it('拒绝未知资源类型及资源引用的额外字段', () => {
    expect(
      ResourceRefSchema.safeParse({ ...resource, type: 'invoice' }).success,
    ).toBe(false);
    expect(
      ResourceRefSchema.safeParse({ ...resource, tenant_id: 't-other' })
        .success,
    ).toBe(false);
  });
});

describe('动作回执及工具结果保持独立状态语义', () => {
  it.each(['succeeded', 'rejected', 'failed', 'unknown'])(
    '接受动作结果 %s',
    (outcome) => {
      expect(
        ActionReceiptSchema.safeParse({ ...receipt, outcome }).success,
      ).toBe(true);
    },
  );

  it('允许无资源回执并拒绝嵌套资源额外字段及未知执行模式', () => {
    expect(
      ActionReceiptSchema.safeParse({ ...receipt, resource: null }).success,
    ).toBe(true);
    expect(
      ActionReceiptSchema.safeParse({
        ...receipt,
        resource: { ...resource, owner_id: 'u-other' },
      }).success,
    ).toBe(false);
    expect(
      ActionReceiptSchema.safeParse({ ...receipt, data_mode: 'test' }).success,
    ).toBe(false);
    expect(
      ActionReceiptSchema.safeParse({ ...receipt, outcome: 'cancelled' })
        .success,
    ).toBe(false);
    expect(
      ActionReceiptSchema.safeParse({ ...receipt, token: 'secret' }).success,
    ).toBe(false);
  });

  it.each([
    'ok',
    'requires_input',
    'requires_confirmation',
    'rejected',
    'error',
    'unknown',
  ])('接受工具结果 %s', (status) => {
    expect(
      ToolResultSchema.parse({
        status,
        data: null,
        evidence_refs: [],
        action_id: null,
        error_code: null,
      }),
    ).toEqual({
      status,
      data: null,
      evidence_refs: [],
      action_id: null,
      error_code: null,
    });
  });

  it('校验工具请求固定字段，数据字段必须显式存在', () => {
    const request = {
      name: 'finance.document.get',
      version: '1',
      arguments: { id: 'clm-001' },
      run_id: 'run-1',
      call_id: 'call-1',
    };
    expect(ToolRequestSchema.parse(request)).toEqual(request);
    expect(ToolRequestSchema.safeParse({ ...request, actor }).success).toBe(
      false,
    );
    expect(
      ToolRequestSchema.safeParse({
        name: 'finance.document.get',
        version: '1',
        run_id: 'run-1',
        call_id: 'call-1',
      }).success,
    ).toBe(false);
    expect(
      ToolResultSchema.safeParse({
        status: 'ok',
        evidence_refs: [],
        action_id: null,
        error_code: null,
      }).success,
    ).toBe(false);
    expect(
      ToolResultSchema.safeParse({
        status: 'completed',
        data: {},
        evidence_refs: [],
        action_id: null,
        error_code: null,
      }).success,
    ).toBe(false);
  });

  it.each([
    'queued',
    'running',
    'waiting_user',
    'waiting_confirmation',
    'reconciling',
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
  ])('接受 Agent run 状态 %s', (status) =>
    expect(RunStatusSchema.safeParse(status).success).toBe(true),
  );

  it('拒绝领域任务状态作为 Agent run 状态', () => {
    expect(RunStatusSchema.safeParse('paused').success).toBe(false);
    expect(RunStatusSchema.safeParse('completed').success).toBe(false);
    expect(RunStatusSchema.safeParse('unknown').success).toBe(false);
  });
});

describe('统一响应与错误', () => {
  const responseSchema = createApiResponseSchema(
    z.strictObject({ resource: ResourceRefSchema }),
  );

  it('成功响应保留完整 meta，错误响应使用同一 meta 协议', () => {
    const success = { data: { resource }, meta };
    const failure = {
      error: {
        code: 'VERSION_CONFLICT',
        message: '单据已更新，请刷新后再操作。',
        retryable: false,
        details: { current_version: 4 },
      },
      meta,
    };
    expect(responseSchema.parse(success)).toEqual(success);
    expect(responseSchema.parse(failure)).toEqual(failure);
  });

  it('错误响应兼容公共契约中仅含 request_id 和 trace_id 的 meta', () => {
    const failure = {
      error: { code: 'NOT_FOUND', message: '资源不存在。', retryable: false },
      meta: { request_id: 'req-1', trace_id: 'trace-1' },
    };
    expect(responseSchema.parse(failure)).toEqual(failure);
    expect(
      responseSchema.safeParse({ ...failure, meta: { trace_id: 'trace-1' } })
        .success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({ ...failure, meta: { request_id: 'req-1' } })
        .success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        ...failure,
        meta: { ...failure.meta, debug: true },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        ...failure,
        meta: { ...failure.meta, data_mode: 'test' },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        ...failure,
        meta: { ...failure.meta, server_time: '2026-11-05T09:00:00+08:00' },
      }).success,
    ).toBe(false);
  });

  it.each([
    'VALIDATION_ERROR',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'VERSION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_STATE',
    'CONFIRMATION_EXPIRED',
    'REVALIDATION_REQUIRED',
    'RATE_LIMITED',
    'DEPENDENCY_UNAVAILABLE',
    'OUTCOME_UNKNOWN',
  ])('接受固定错误码 %s', (code) => {
    expect(
      ApiErrorSchema.safeParse({
        code,
        message: '请求无法完成。',
        retryable: false,
        details: {},
      }).success,
    ).toBe(true);
  });

  it('错误 details 可省略，拒绝未知错误码和额外敏感字段', () => {
    expect(
      ApiErrorSchema.safeParse({
        code: 'NOT_FOUND',
        message: '资源不存在。',
        retryable: false,
      }).success,
    ).toBe(true);
    expect(
      ApiErrorSchema.safeParse({
        code: 'INTERNAL_ERROR',
        message: '请求失败。',
        retryable: true,
      }).success,
    ).toBe(false);
    expect(
      ApiErrorSchema.safeParse({
        code: 'NOT_FOUND',
        message: '资源不存在。',
        retryable: false,
        sql: 'select 1',
      }).success,
    ).toBe(false);
  });

  it('拒绝混合成功/错误信封及递归定义对象的未知字段', () => {
    const error = {
      code: 'NOT_FOUND',
      message: '资源不存在。',
      retryable: false,
    };
    expect(
      responseSchema.safeParse({ data: { resource }, error, meta }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({ data: { resource }, meta, debug: true })
        .success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        data: { resource: { ...resource, hidden: true } },
        meta,
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        data: { resource },
        meta: { ...meta, token: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        data: { resource },
        meta: { ...meta, data_mode: 'test' },
      }).success,
    ).toBe(false);
    expect(
      responseSchema.safeParse({
        data: { resource },
        meta: { request_id: 'req-1', trace_id: 'trace-1' },
      }).success,
    ).toBe(false);
  });
});
