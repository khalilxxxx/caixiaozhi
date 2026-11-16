import { describe, expect, it } from 'vitest';
import {
  diffRuleVersions,
  type RuleDiffVersion,
} from '../../packages/finance/src/rule-diff.js';
import {
  personalMealsDsl,
  BASELINE_RULES,
} from '../../packages/finance/src/rule-seeds.js';
const version = (number: number): RuleDiffVersion => ({
  id: `explicit-version-${number}`,
  version_number: number,
  dsl_json: personalMealsDsl(),
  source_kind: 'personal',
  source_citation_ids: [],
  source_review_required: false,
});
describe('规则版本确定性语义差异', () => {
  it('比较真实gt/gte和整数分阈值，中文解释不舍入大金额，不覆盖原版本', () => {
    const from = version(1),
      to = version(2);
    if (to.dsl_json.predicate.op !== 'compare')
      throw new Error('explicit compare fixture');
    to.dsl_json.predicate.comparator = 'gte';
    to.dsl_json.predicate.right = {
      op: 'literal',
      value: { amount_minor: '900719925474099301', currency: 'CNY' },
    };
    const before = structuredClone({ from, to }),
      result = diffRuleVersions(from, to);
    expect(result.changes.map((change) => change.kind)).toContain('comparison');
    expect(result.changes.map((change) => change.kind)).toContain('threshold');
    expect(
      result.changes.find((change) => change.kind === 'comparison')
        ?.explanation,
    ).toContain('严格大于');
    expect(
      result.changes.find((change) => change.kind === 'comparison')
        ?.explanation,
    ).toContain('大于或等于');
    expect(
      result.changes.find((change) => change.kind === 'threshold')?.explanation,
    ).toContain('9007199254740993.01');
    expect({ from, to }).toEqual(before);
    expect(
      result.changes.some((change) => change.kind === 'missing_policy'),
    ).toBe(false);
  });
  it('计量、日期口径、集合sum/count/筛选变化分别解释', () => {
    const from = version(1),
      to = version(2);
    to.dsl_json.applicability.unit = 'person_day';
    to.dsl_json.applicability.basis = 'expense_date';
    if (to.dsl_json.predicate.op !== 'compare') throw new Error('fixture');
    to.dsl_json.predicate.left = { op: 'count', collection: 'invoices' };
    const changes = diffRuleVersions(from, to).changes;
    expect(
      changes.filter((change) => change.kind === 'measurement'),
    ).toHaveLength(2);
    expect(
      changes.some(
        (change) =>
          change.kind === 'aggregation' &&
          change.explanation.includes('汇总') &&
          change.explanation.includes('计数'),
      ),
    ).toBe(true);
  });
  it('范围数组换序不是语义变化，增删部门/用途/生效区间必须报告', () => {
    const from = version(1),
      to = version(2);
    from.dsl_json.applicability.department_ids = ['dept-sales', 'dept-tech'];
    to.dsl_json.applicability.department_ids = ['dept-tech', 'dept-sales'];
    expect(diffRuleVersions(from, to).changes).toEqual([]);
    to.dsl_json.applicability.department_ids = ['dept-sales'];
    to.dsl_json.applicability.purposes = ['finance_review'];
    to.dsl_json.applicability.effective_to = '2027-01-01';
    expect(
      diffRuleVersions(from, to).changes.filter(
        (change) => change.kind === 'scope',
      ),
    ).toHaveLength(3);
  });
  it('exists换为compare及必查缺材料分类变化会解释固定三值缺失语义', () => {
    const from = version(1),
      to = version(2);
    from.dsl_json = structuredClone(BASELINE_RULES[0]!.dsl);
    to.dsl_json = structuredClone(from.dsl_json);
    from.dsl_json.predicate = {
      op: 'exists',
      value: { op: 'field', path: 'invoice.invoice_number' },
    };
    to.dsl_json.predicate = {
      op: 'compare',
      comparator: 'eq',
      left: { op: 'field', path: 'invoice.invoice_number' },
      right: { op: 'literal', value: '已确认' },
    };
    if (to.dsl_json.outcome_mode !== 'mandatory_check')
      throw new Error('fixture');
    to.dsl_json.failure_kind = 'missing_evidence';
    const change = diffRuleVersions(from, to).changes.find(
      (item) => item.kind === 'missing_policy',
    );
    expect(change?.explanation).toContain('明确缺失');
    expect(change?.explanation).toContain('未知');
    expect(change?.explanation).toContain('缺少证据');
  });
  it('同一all/any条件调序不误报，调序同时改一个阈值仍只定位原比较条件', () => {
    const from = version(1),
      to = version(2),
      first = structuredClone(from.dsl_json.predicate),
      second = {
        op: 'exists' as const,
        value: { op: 'field' as const, path: 'department_id' },
      };
    from.dsl_json.predicate = { op: 'all', args: [first, second] };
    to.dsl_json.predicate = {
      op: 'all',
      args: [structuredClone(second), structuredClone(first)],
    };
    expect(diffRuleVersions(from, to).changes).toEqual([]);
    const changed = to.dsl_json.predicate.args[1]!;
    if (changed.op !== 'compare') throw new Error('fixture');
    changed.right = {
      op: 'literal',
      value: { amount_minor: '120000', currency: 'CNY' },
    };
    const diff = diffRuleVersions(from, to);
    expect(
      diff.changes.filter((change) => change.kind === 'threshold'),
    ).toHaveLength(1);
    expect(diff.changes.some((change) => change.kind === 'logic')).toBe(false);
  });
  it('来源引用及独立历史mapping版本/hash变化均报告，缺历史证明不冒充现行一致', () => {
    const from = version(1),
      to = version(2);
    from.source_kind = 'policy';
    from.source_citation_ids = ['citation-v1-paragraph-hash'];
    to.source_kind = 'manual_company_decision';
    to.source_review_required = true;
    from.mapping_snapshot = {
      revision: 1,
      field_catalog_version: 1,
      mappings: [{ id: 'map-v1', version_number: 1, content_hash: 'hash-v1' }],
    };
    to.mapping_snapshot = {
      revision: 2,
      field_catalog_version: 1,
      mappings: [{ id: 'map-v2', version_number: 2, content_hash: 'hash-v2' }],
    };
    from.mapping_basis = 'activation_proof';
    to.mapping_basis = 'latest_completed_test';
    const diff = diffRuleVersions(from, to);
    expect(diff.changes.some((change) => change.kind === 'source')).toBe(true);
    const mapping = diff.changes.find((change) => change.kind === 'mapping');
    expect(mapping?.before).toEqual(from.mapping_snapshot);
    expect(mapping?.after).toEqual(to.mapping_snapshot);
    expect(diff.warnings.join('')).toContain('测试');
    delete from.mapping_snapshot;
    delete to.mapping_snapshot;
    const unavailable = diffRuleVersions(from, to);
    expect(unavailable.warnings.join('')).toContain('无法判定');
    expect(
      unavailable.changes.some((change) => change.kind === 'mapping'),
    ).toBe(false);
  });
});
