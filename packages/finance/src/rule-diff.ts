import type { RuleDsl } from '@caixiaozhi/contracts/rules';
import { compileRule } from './evaluator.js';
import { canonicalJson } from './hash.js';
export type RuleDiffVersion = {
  id: string;
  version_number: number;
  dsl_json: RuleDsl;
  source_kind: string;
  source_citation_ids: string[];
  source_review_required: boolean;
  mapping_snapshot?: {
    revision: number;
    field_catalog_version: number;
    mappings: Array<{
      id: string;
      version_number: number;
      content_hash: string;
    }>;
  } | null;
  mapping_basis?: 'activation_proof' | 'latest_completed_test' | 'unknown';
};
export type RuleSemanticChange = {
  kind:
    | 'comparison'
    | 'threshold'
    | 'aggregation'
    | 'measurement'
    | 'scope'
    | 'missing_policy'
    | 'source'
    | 'mapping'
    | 'logic'
    | 'outcome';
  path: string;
  before: unknown;
  after: unknown;
  explanation: string;
};
type Node = Record<string, unknown>;
const names: Record<string, string> = {
  gt: '严格大于',
  gte: '大于或等于',
  lt: '严格小于',
  lte: '小于或等于',
  eq: '等于',
  ne: '不等于',
  in: '属于集合',
  sum: '金额汇总',
  count: '行数计数',
  multiply: '精确相乘',
  for_each: '逐项检查',
  all: '全部条件满足',
  any: '任一条件满足',
  not: '条件取反',
  exists: '存在性检查',
  compare: '比较检查',
  expense_items: '费用行',
  invoices: '发票',
  document_category_total: '每单分类合计',
  item: '逐项',
  document: '每张单据',
  room_night: '每间夜',
  invoice: '每张发票',
  person_day: '每人每天',
  submitted_date: '提交日期',
  evaluation_date: '评估日期',
  expense_date: '逐项消费日期',
  expense_claim: '报销单',
  travel: '差旅申请',
  oa_request: '招待申请',
  employee_precheck: '本人预检',
  manager_review: '主管审核',
  finance_review: '财务审核',
  policy: '制度引用',
  manual_company_decision: '人工公司决定',
  personal: '个人提醒',
  mandatory_check: '公司必查',
  attention_trigger: '个人关注提醒',
};
const label = (value: string) => names[value] ?? value;
const object = (value: unknown): Node | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Node)
    : null;
const equal = (left: unknown, right: unknown) =>
  canonicalJson(left ?? null) === canonicalJson(right ?? null);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const node = object(value);
  if (!node) return value;
  const result: Node = {};
  for (const [key, item] of Object.entries(node)) result[key] = canonical(item);
  if ((node.op === 'all' || node.op === 'any') && Array.isArray(result.args))
    result.args = result.args.sort((a, b) =>
      canonicalJson(a).localeCompare(canonicalJson(b)),
    );
  return result;
}
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  const node = object(value);
  if (!node) return value;
  if (node.op === 'literal')
    return {
      op: 'literal',
      type:
        object(node.value)?.currency === 'CNY' ? 'money' : typeof node.value,
    };
  const result: Node = {};
  for (const [key, item] of Object.entries(node))
    result[key] =
      key === 'comparator' && ['gt', 'gte', 'lt', 'lte'].includes(String(item))
        ? String(item).startsWith('g')
          ? 'lower_boundary'
          : 'upper_boundary'
        : shape(item);
  return result;
}
function amount(value: unknown): string {
  const record = object(value);
  if (record?.currency === 'CNY' && typeof record.amount_minor === 'string') {
    const n = BigInt(record.amount_minor),
      absolute = n < 0n ? -n : n;
    return `${n < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')} 元（${n} 分）`;
  }
  return typeof value === 'string' ? `“${value}”` : JSON.stringify(value);
}
function explain(value: unknown): string {
  const node = object(value);
  if (!node)
    return value === null || value === undefined ? '未设置' : amount(value);
  if (node.op === 'field') return String(node.path);
  if (node.op === 'literal') return amount(node.value);
  if (node.op === 'sum' || node.op === 'count')
    return `${label(String(node.collection))}${node.where ? '按筛选条件' : ''}${label(String(node.op))}`;
  if (node.op === 'for_each')
    return `对${label(String(node.collection))}${label('for_each')}`;
  return label(String(node.op ?? '表达式'));
}
function missingSignature(dsl: RuleDsl) {
  const operators: string[] = [];
  const walk = (value: unknown) => {
    const node = object(value);
    if (!node) {
      if (Array.isArray(value)) value.forEach(walk);
      return;
    }
    if (
      [
        'exists',
        'compare',
        'sum',
        'count',
        'for_each',
        'all',
        'any',
        'not',
      ].includes(String(node.op))
    )
      operators.push(String(node.op));
    for (const child of Object.values(node)) walk(child);
  };
  walk(dsl.predicate);
  return {
    operators: operators.sort(),
    failure_kind:
      dsl.outcome_mode === 'mandatory_check' ? dsl.failure_kind : null,
  };
}
function missingText(dsl: RuleDsl) {
  const signature = missingSignature(dsl),
    parts = ['来源未映射或不可用始终返回未知'];
  if (signature.operators.includes('exists'))
    parts.push('存在性检查对可靠的明确缺失返回不满足');
  if (signature.operators.includes('compare'))
    parts.push('比较检查遇到必要值缺失返回未知');
  if (
    signature.operators.some((op) => ['sum', 'count', 'for_each'].includes(op))
  )
    parts.push('集合筛选或必要行值未知会传播未知');
  if (dsl.outcome_mode === 'mandatory_check')
    parts.push(
      dsl.failure_kind === 'missing_evidence'
        ? '必查不满足归为缺少证据'
        : '必查不满足归为明确违规',
    );
  return parts.join('；');
}
/** 只比较已授权取出的两个独立版本，不读取现行映射、不调用模型、不修改原始DSL。 */
export function diffRuleVersions(
  from: RuleDiffVersion,
  to: RuleDiffVersion,
): { changes: RuleSemanticChange[]; message: string; warnings: string[] } {
  const before = compileRule(from.dsl_json).dsl,
    after = compileRule(to.dsl_json).dsl;
  const changes: RuleSemanticChange[] = [],
    warnings: string[] = [];
  const add = (
    kind: RuleSemanticChange['kind'],
    path: string,
    a: unknown,
    b: unknown,
    explanation: string,
  ) => {
    if (!equal(canonical(a), canonical(b)))
      changes.push({
        kind,
        path,
        before: structuredClone(a ?? null),
        after: structuredClone(b ?? null),
        explanation,
      });
  };
  const walk = (a: unknown, b: unknown, path: string) => {
    if (equal(canonical(a), canonical(b))) return;
    const left = object(a),
      right = object(b);
    if (!left || !right) {
      add('logic', path, a, b, `${path}由${explain(a)}改为${explain(b)}。`);
      return;
    }
    if (left.op !== right.op) {
      const aggregation = [left.op, right.op].some((op) =>
        ['sum', 'count', 'for_each', 'multiply'].includes(String(op)),
      );
      add(
        aggregation ? 'aggregation' : 'logic',
        path,
        a,
        b,
        `${path}由${explain(a)}改为${explain(b)}。`,
      );
      return;
    }
    if (left.op === 'literal') {
      const money =
          object(left.value)?.currency === 'CNY' ||
          object(right.value)?.currency === 'CNY',
        numeric =
          typeof left.value === 'string' &&
          typeof right.value === 'string' &&
          /^\d+(?:\.\d+)?$/.test(left.value) &&
          /^\d+(?:\.\d+)?$/.test(right.value);
      add(
        money || numeric ? 'threshold' : 'logic',
        `${path}.value`,
        left.value,
        right.value,
        `${money ? '金额阈值' : numeric ? '数量阈值' : '条件取值'}由${amount(left.value)}改为${amount(right.value)}。`,
      );
      return;
    }
    if (left.op === 'compare')
      add(
        'comparison',
        `${path}.comparator`,
        left.comparator,
        right.comparator,
        `比较边界由${label(String(left.comparator))}改为${label(String(right.comparator))}；等于阈值时请按新比较符核对结果。`,
      );
    if (left.collection !== right.collection)
      add(
        'aggregation',
        `${path}.collection`,
        left.collection,
        right.collection,
        `处理集合由${label(String(left.collection))}改为${label(String(right.collection))}。`,
      );
    if (left.op === 'field') {
      add(
        'logic',
        `${path}.path`,
        left.path,
        right.path,
        `读取字段由${String(left.path)}改为${String(right.path)}。`,
      );
      return;
    }
    if (
      (left.op === 'all' || left.op === 'any') &&
      Array.isArray(left.args) &&
      Array.isArray(right.args)
    ) {
      const remaining = [...right.args];
      left.args.forEach((old, index) => {
        let match = remaining.findIndex((next) =>
          equal(canonical(old), canonical(next)),
        );
        if (match < 0)
          match = remaining.findIndex((next) =>
            equal(canonical(shape(old)), canonical(shape(next))),
          );
        const next = match >= 0 ? remaining.splice(match, 1)[0] : null;
        walk(old, next, `${path}.args[${index}]`);
      });
      remaining.forEach((next, index) =>
        walk(null, next, `${path}.args[新增${index + 1}]`),
      );
      return;
    }
    for (const key of ['left', 'right', 'value', 'where', 'predicate', 'arg'])
      if (left[key] !== undefined || right[key] !== undefined)
        walk(left[key], right[key], `${path}.${key}`);
  };
  walk(before.predicate, after.predicate, 'predicate');
  const scopeNames: Record<string, string> = {
    modules: '适用模块',
    department_ids: '适用部门',
    purposes: '审核用途',
    effective_from: '生效起日',
    effective_to: '失效日期（不含当天）',
  };
  for (const key of [
    'modules',
    'department_ids',
    'purposes',
    'effective_from',
    'effective_to',
  ] as const) {
    const a = before.applicability[key],
      b = after.applicability[key],
      sorted = (v: typeof a) => (Array.isArray(v) ? [...new Set(v)].sort() : v);
    add(
      'scope',
      `applicability.${key}`,
      sorted(a),
      sorted(b),
      `${scopeNames[key]}由${Array.isArray(a) ? [...a].sort().map(label).join('、') : (a ?? '无限期')}改为${Array.isArray(b) ? [...b].sort().map(label).join('、') : (b ?? '无限期')}。`,
    );
  }
  for (const key of ['unit', 'basis'] as const)
    add(
      'measurement',
      `applicability.${key}`,
      before.applicability[key],
      after.applicability[key],
      `${key === 'unit' ? '计量单位' : '业务日期口径'}由${label(before.applicability[key])}改为${label(after.applicability[key])}。`,
    );
  walk(
    before.applicability.condition,
    after.applicability.condition,
    'applicability.condition',
  );
  add(
    'outcome',
    'outcome_mode',
    before.outcome_mode,
    after.outcome_mode,
    `规则用途由${label(before.outcome_mode)}改为${label(after.outcome_mode)}。`,
  );
  if (!equal(missingSignature(before), missingSignature(after)))
    changes.push({
      kind: 'missing_policy',
      path: 'missing_semantics',
      before: missingSignature(before),
      after: missingSignature(after),
      explanation: `缺失处理由“${missingText(before)}”改为“${missingText(after)}”。`,
    });
  add(
    'source',
    'source_kind',
    from.source_kind,
    to.source_kind,
    `规则来源由${label(from.source_kind)}改为${label(to.source_kind)}。`,
  );
  add(
    'source',
    'source_citation_ids',
    [...new Set(from.source_citation_ids)].sort(),
    [...new Set(to.source_citation_ids)].sort(),
    '制度引用的版本、段落或引用标识已变化，需重新核对来源。',
  );
  add(
    'source',
    'source_review_required',
    from.source_review_required,
    to.source_review_required,
    `来源复核状态由${from.source_review_required ? '待复核' : '未标记待复核'}改为${to.source_review_required ? '待复核' : '未标记待复核'}。`,
  );
  const mapping = (version: RuleDiffVersion) =>
    version.mapping_snapshot
      ? {
          ...version.mapping_snapshot,
          mappings: [...version.mapping_snapshot.mappings].sort(
            (a, b) =>
              a.id.localeCompare(b.id) || a.version_number - b.version_number,
          ),
        }
      : null;
  if (!from.mapping_snapshot || !to.mapping_snapshot)
    warnings.push(
      '至少一个版本未记录可用历史映射快照，无法判定映射依赖是否一致；未使用现行映射代替历史版本。',
    );
  if (
    from.mapping_basis === 'latest_completed_test' ||
    to.mapping_basis === 'latest_completed_test'
  )
    warnings.push(
      '部分映射信息来自该版本最近已完成测试，不等同于发布时锁定证明。',
    );
  add(
    'mapping',
    'mapping_snapshot',
    mapping(from),
    mapping(to),
    from.mapping_snapshot && to.mapping_snapshot
      ? '映射依赖的修订、目录版本、映射版本或内容校验值发生变化；请按两个独立历史快照重新核对。'
      : '历史映射记录一侧缺失，无法判定实际依赖是否变化，不能以现行映射替代。',
  );
  return {
    changes,
    message: changes.length
      ? `第 ${from.version_number} 版至第 ${to.version_number} 版共发现 ${changes.length} 项语义或依赖变化。`
      : '两个版本未发现已知语义差异；缺失的历史依赖仍需核实。',
    warnings,
  };
}
