import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../../apps/api/src/modules/integrations/catalog.js';
import {
  ajv,
  rejectModelCredentials,
  validateDefinition,
} from '../../apps/api/src/modules/integrations/schemas.js';
const samples: Record<string, unknown> = {
  'finance.todo.list': {},
  'finance.document.get': { type: 'expense_claim', id: 'clm-001' },
  'finance.preaudit.start': {
    purpose: 'manager_review',
    documents: [{ type: 'expense_claim', id: 'clm-001', version: 1 }],
  },
  'finance.preaudit.get': { task_id: 'task-1' },
  'finance.rules.propose': {
    natural_language: '餐饮超过1000元提醒',
    module: 'expense_claim',
    purpose: 'manager_review',
  },
  'finance.rules.test': {
    rule_id: 'rule-1',
    draft_version: 1,
    test_set_id: 'boundary-v1',
  },
  'finance.knowledge.search': {
    query: '住宿标准',
    business_date: '2026-11-05',
  },
  'finance.analytics.query': {
    metric: 'expense.completed_amount',
    period: {
      from: '2026-11-01',
      to_exclusive: '2026-11-06',
      timezone: 'Asia/Shanghai',
      date_basis: 'completed_at',
    },
  },
  'finance.report.create': {
    analysis_snapshot_id: 'snapshot-1',
    template: 'expense-summary',
  },
  'finance.travel.propose_patch': {
    id: 'travel-1',
    expected_version: 1,
    prompt: '修改返程',
    selected_material_refs: [],
  },
  'finance.expense.propose_patch': {
    id: 'claim-1',
    expected_version: 1,
    prompt: '整理费用',
    selected_material_refs: [],
    invoice_refs: [],
  },
  'finance.action.prepare': {
    action: 'travel.submit',
    resource_refs: [{ type: 'travel', id: 'travel-1', version: 1 }],
    args: {},
  },
  'finance.action.status': { action_id: 'action-1' },
};
describe('首期能力冻结输入契约', () => {
  it('规则测试仅接受已登记测试集，输出允许真实排队任务', () => {
    const definition = BUILTIN_CAPABILITIES.find(
        (d) => d.name === 'finance.rules.test',
      )!,
      input = ajv.compile(definition.input_schema),
      output = ajv.compile(definition.output_schema);
    expect(
      input({ rule_id: 'rule-1', draft_version: 1, test_set_id: 'unknown' }),
    ).toBe(false);
    expect(
      input({
        rule_id: 'rule-1',
        draft_version: 1,
        test_set_id: 'boundary-v1',
        cases: [],
      }),
    ).toBe(false);
    expect(
      output({
        task_id: 'task-1',
        test_run_id: 'task-1',
        rule_id: 'rule-1',
        job_id: 'job-1',
        origin_run_id: null,
        status: 'queued',
        poll_after_ms: 1000,
      }),
    ).toBe(true);
  });
  for (const definition of BUILTIN_CAPABILITIES)
    it(`${definition.name} 接受领域参数并拒绝身份覆盖/未知参数`, () => {
      const d = validateDefinition(definition),
        validate = ajv.compile(d.input_schema);
      expect(validate(samples[d.name])).toBe(true);
      expect(
        validate({ ...(samples[d.name] as object), user_id: 'u-liu' }),
      ).toBe(false);
      expect(
        validate({
          ...(samples[d.name] as object),
          url: 'https://untrusted.example',
        }),
      ).toBe(false);
      expect(ajv.compile(d.output_schema)({ invented_success: true })).toBe(
        false,
      );
      expect(() =>
        rejectModelCredentials({
          args: { base_url: 'http://127.0.0.1/private' },
        }),
      ).toThrow();
    });
});
