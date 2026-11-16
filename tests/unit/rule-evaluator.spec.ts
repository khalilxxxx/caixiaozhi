import { describe, expect, it } from 'vitest';
import {
  compileRule,
  evaluateRule,
  decimalYuanToMinor,
} from '../../packages/finance/src/evaluator.js';
import type { RuleDsl, SrsInput, Predicate } from '@caixiaozhi/contracts/rules';
const input = (amount: string | null): SrsInput => ({
  schema_version: 1,
  document: { type: 'expense_claim', id: 'test-claim', version: 1 },
  business_date: '2026-11-05',
  applicant_id: 'test-user',
  department_id: 'dept-sales',
  total_amount: amount ? { amount_minor: amount, currency: 'CNY' } : null,
  expense_items: [
    {
      id: 'line-1',
      category: 'meals',
      source_expense_type: 'meals',
      amount: amount ? { amount_minor: amount, currency: 'CNY' } : null,
      invoice_refs: ['invoice-1'],
      spent_on: '2026-11-04',
      room_nights: null,
      oa_request_ref: null,
    },
  ],
  invoices: [
    {
      id: 'invoice-1',
      amount: amount ? { amount_minor: amount, currency: 'CNY' } : null,
      invoice_number: 'DEMO-TEST',
      verified: true,
    },
  ],
  external_facts: {},
  field_states: {},
});
const predicate: Predicate = {
  op: 'compare',
  comparator: 'gt',
  left: {
    op: 'sum',
    collection: 'expense_items',
    where: {
      op: 'compare',
      comparator: 'eq',
      left: { op: 'field', path: 'item.category' },
      right: { op: 'literal', value: 'meals' },
    },
    value: { op: 'field', path: 'item.amount' },
  },
  right: { op: 'literal', value: { amount_minor: '100000', currency: 'CNY' } },
};
const dsl = (p: Predicate = predicate): RuleDsl => ({
  dsl_version: 1,
  outcome_mode: 'attention_trigger',
  applicability: {
    modules: ['expense_claim'],
    department_ids: ['dept-sales'],
    purposes: ['manager_review'],
    basis: 'submitted_date',
    unit: 'document_category_total',
    effective_from: '2026-01-01',
    effective_to: null,
  },
  predicate: p,
});

describe('SRS确定性解释器', () => {
  it('每单餐饮gt边界保持分精度，缺失不当作零', () => {
    const compiled = compileRule(dsl());
    expect(evaluateRule(compiled, input('99999')).truth).toBe('false');
    expect(evaluateRule(compiled, input('100000')).truth).toBe('false');
    expect(evaluateRule(compiled, input('100001')).truth).toBe('true');
    expect(evaluateRule(compiled, input(null)).truth).toBe('unknown');
  });
  it('未知筛选条件传播unknown，不丢弃该行', () => {
    const source = input('99999');
    source.field_states['expense_items.line-1.category'] = {
      state: 'unmapped',
      reason: '分类未确认',
    };
    expect(evaluateRule(compileRule(dsl()), source).truth).toBe('unknown');
  });
  it('三值all/any/not保持逻辑并保留全部证据', () => {
    const known: Predicate = {
      op: 'compare',
      comparator: 'eq',
      left: { op: 'literal', value: 'a' },
      right: { op: 'literal', value: 'b' },
    };
    const unknown: Predicate = {
      op: 'compare',
      comparator: 'eq',
      left: { op: 'field', path: 'total_amount' },
      right: { op: 'literal', value: { amount_minor: '0', currency: 'CNY' } },
    };
    const source = input(null);
    expect(
      evaluateRule(
        compileRule(dsl({ op: 'all', args: [known, unknown] })),
        source,
      ).truth,
    ).toBe('false');
    expect(
      evaluateRule(
        compileRule(dsl({ op: 'any', args: [known, unknown] })),
        source,
      ).truth,
    ).toBe('unknown');
    expect(
      evaluateRule(compileRule(dsl({ op: 'not', arg: unknown })), source).truth,
    ).toBe('unknown');
  });
  it('exists区分可靠缺失与来源不可用', () => {
    const source = input('100000');
    source.invoices[0]!.invoice_number = null;
    const rule = compileRule(
      dsl({
        op: 'for_each',
        collection: 'invoices',
        predicate: {
          op: 'exists',
          value: { op: 'field', path: 'invoice.invoice_number' },
        },
      }),
    );
    expect(evaluateRule(rule, source).truth).toBe('false');
    source.field_states['invoices.invoice-1.invoice_number'] = {
      state: 'unavailable',
      reason: '查询失败',
    };
    expect(evaluateRule(rule, source).truth).toBe('unknown');
  });
  it('住宿金额按有理数量精确交叉相乘，不能先除后舍入', () => {
    const source = input('220000');
    source.expense_items[0]!.category = 'lodging';
    source.expense_items[0]!.room_nights = '2';
    const rule = compileRule(
      dsl({
        op: 'for_each',
        collection: 'expense_items',
        predicate: {
          op: 'compare',
          comparator: 'lte',
          left: { op: 'field', path: 'item.amount' },
          right: {
            op: 'multiply',
            left: {
              op: 'literal',
              value: { amount_minor: '80000', currency: 'CNY' },
            },
            right: { op: 'field', path: 'item.room_nights' },
          },
        },
      }),
    );
    expect(evaluateRule(rule, source).truth).toBe('false');
    source.expense_items[0]!.room_nights = '2.75';
    expect(evaluateRule(rule, source).truth).toBe('true');
  });
  it('不执行脚本，拒绝未知字段、操作符和超深AST', () => {
    expect(() =>
      compileRule({
        ...dsl(),
        predicate: { op: 'eval', script: 'globalThis.pwned=true' },
      }),
    ).toThrow();
    expect(() =>
      compileRule(
        dsl({ op: 'exists', value: { op: 'field', path: 'employee.salary' } }),
      ),
    ).toThrow();
    let deep: Predicate = predicate;
    for (let i = 0; i < 10; i++) deep = { op: 'not', arg: deep };
    expect(() => compileRule(dsl(deep))).toThrow();
    expect(() => decimalYuanToMinor('1000.001')).toThrow();
    expect(decimalYuanToMinor('1000.01')).toBe('100001');
  });
});
