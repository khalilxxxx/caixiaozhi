import type { Predicate, RuleDsl } from '@caixiaozhi/contracts/rules';
const category = (name: string): Predicate => ({
  op: 'compare',
  comparator: 'eq',
  left: { op: 'field', path: 'item.category' },
  right: { op: 'literal', value: name },
});
const condition = (name: string): Predicate => ({
  op: 'compare',
  comparator: 'gt',
  left: { op: 'count', collection: 'expense_items', where: category(name) },
  right: { op: 'literal', value: '0' },
});
const applicability = {
  modules: ['expense_claim' as const],
  department_ids: ['dept-sales', 'dept-tech'],
  purposes: ['employee_precheck', 'manager_review', 'finance_review'] as const,
  basis: 'submitted_date' as const,
  unit: 'document' as const,
  effective_from: '2026-01-01',
  effective_to: null,
};
export const BASELINE_RULES: Array<{
  id: string;
  versionId: string;
  category: 'invoice' | 'lodging' | 'meals';
  name: string;
  dsl: RuleDsl;
}> = [
  {
    id: 'rule-company-invoice',
    versionId: 'rv-company-invoice-1',
    category: 'invoice',
    name: '票据核验要求',
    dsl: {
      dsl_version: 1,
      outcome_mode: 'mandatory_check',
      failure_kind: 'violation',
      applicability: {
        ...applicability,
        purposes: [...applicability.purposes],
      },
      predicate: {
        op: 'for_each',
        collection: 'invoices',
        predicate: {
          op: 'compare',
          comparator: 'eq',
          left: { op: 'field', path: 'invoice.verified' },
          right: { op: 'literal', value: true },
        },
      },
    },
  },
  {
    id: 'rule-company-lodging',
    versionId: 'rv-company-lodging-1',
    category: 'lodging',
    name: '住宿每间夜800元上限',
    dsl: {
      dsl_version: 1,
      outcome_mode: 'mandatory_check',
      failure_kind: 'violation',
      applicability: {
        ...applicability,
        purposes: [...applicability.purposes],
        unit: 'room_night',
        condition: condition('lodging'),
      },
      predicate: {
        op: 'for_each',
        collection: 'expense_items',
        where: category('lodging'),
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
      },
    },
  },
  {
    id: 'rule-company-oa',
    versionId: 'rv-company-oa-1',
    category: 'meals',
    name: '餐饮关联已批准招待申请',
    dsl: {
      dsl_version: 1,
      outcome_mode: 'mandatory_check',
      failure_kind: 'violation',
      applicability: {
        ...applicability,
        purposes: [...applicability.purposes],
        condition: condition('meals'),
      },
      predicate: {
        op: 'compare',
        comparator: 'eq',
        left: { op: 'field', path: 'external_facts.oa_approved' },
        right: { op: 'literal', value: true },
      },
    },
  },
];
export function personalMealsDsl(
  departmentIds = ['dept-sales'],
  amountMinor = '100000',
): RuleDsl {
  return {
    dsl_version: 1,
    outcome_mode: 'attention_trigger',
    applicability: {
      modules: ['expense_claim'],
      department_ids: departmentIds,
      purposes: ['manager_review'],
      basis: 'submitted_date',
      unit: 'document_category_total',
      effective_from: '2026-01-01',
      effective_to: null,
    },
    predicate: {
      op: 'compare',
      comparator: 'gt',
      left: {
        op: 'sum',
        collection: 'expense_items',
        where: category('meals'),
        value: { op: 'field', path: 'item.amount' },
      },
      right: {
        op: 'literal',
        value: { amount_minor: amountMinor, currency: 'CNY' },
      },
    },
  };
}
