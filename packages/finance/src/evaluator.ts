import {
  RuleDslSchema,
  SrsInputSchema,
  type RuleDsl,
  type SrsInput,
  type Predicate,
  type ValueNode,
  type Truth,
} from '@caixiaozhi/contracts/rules';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from './hash.js';

export const FIELD_CATALOG_VERSION = 1;
export const FIELD_CATALOG = new Set([
  'department_id',
  'applicant_id',
  'business_date',
  'total_amount',
  'item.category',
  'item.amount',
  'item.room_nights',
  'item.source_expense_type',
  'item.spent_on',
  'invoice.invoice_number',
  'invoice.verified',
  'invoice.amount',
  'travel.start_on',
  'travel.end_on',
  'external_facts.oa_approved',
]);
export type CompiledRule = {
  dsl: RuleDsl;
  compiled_hash: string;
  fields: string[];
  field_catalog_version: number;
};
export type RuleEvaluation = {
  truth: Truth;
  field_refs: string[];
  unknown_reasons: string[];
  trace: Array<{ op: string; truth?: Truth; field?: string; value?: unknown }>;
};
type Numeric = { kind: 'money' | 'decimal'; n: bigint; d: bigint };
type Scalar = string | boolean | string[] | Numeric;
type Value =
  | { known: true; value: Scalar | null; missing: boolean }
  | { known: false; reason: string };
type Environment = {
  input: SrsInput;
  item?: SrsInput['expense_items'][number];
  invoice?: SrsInput['invoices'][number];
};
const unknown = (reason: string): Value => ({ known: false, reason });
const numeric = (
  n: bigint,
  d = 1n,
  kind: 'money' | 'decimal' = 'decimal',
): Numeric => ({ kind, n, d });
function asNumeric(value: Scalar | null): Numeric | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const negative = value.startsWith('-');
    const [whole = '0', part = ''] = value.replace(/^-/, '').split('.');
    return numeric(
      (negative ? -1n : 1n) *
        (BigInt(whole) * 10n ** BigInt(part.length) + BigInt(part || '0')),
      10n ** BigInt(part.length),
    );
  }
  return null;
}
function toScalar(value: unknown): Scalar | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'amount_minor' in value &&
    typeof value.amount_minor === 'string' &&
    'currency' in value &&
    value.currency === 'CNY'
  )
    return numeric(BigInt(value.amount_minor), 1n, 'money');
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'))
  )
    return value;
  return null;
}
function nodeGuard(node: unknown, depth = 0, counter = { count: 0 }): void {
  if (node === null || typeof node !== 'object') return;
  if (depth > 8 || ++counter.count > 200)
    throw new AppError('VALIDATION_ERROR', '规则表达式超过复杂度限制。');
  if (Array.isArray(node)) {
    for (const child of node) nodeGuard(child, depth, counter);
    return;
  }
  for (const [key, value] of Object.entries(node))
    if (
      !['value', 'applicability'].includes(key) ||
      (typeof value === 'object' && value !== null && 'op' in value)
    )
      nodeGuard(value, depth + 1, counter);
}
export function compileRule(input: unknown): CompiledRule {
  if (input && typeof input === 'object' && 'predicate' in input)
    nodeGuard(input.predicate);
  const dsl = RuleDslSchema.parse(input);
  if (dsl.applicability.condition) nodeGuard(dsl.applicability.condition);
  const fields = new Set<string>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('op' in value && value.op === 'field' && 'path' in value) {
      if (typeof value.path !== 'string' || !FIELD_CATALOG.has(value.path))
        throw new AppError('VALIDATION_ERROR', '规则引用了未登记的字段。', {
          details: {
            path: typeof value.path === 'string' ? value.path : 'predicate',
          },
        });
      fields.add(value.path);
    }
    for (const child of Object.values(value))
      if (child && typeof child === 'object') walk(child);
  };
  walk(dsl);
  return {
    dsl,
    fields: [...fields].sort(),
    field_catalog_version: FIELD_CATALOG_VERSION,
    compiled_hash: canonicalHash({
      dsl,
      field_catalog_version: FIELD_CATALOG_VERSION,
    }),
  };
}
export function evaluatePredicate(
  predicate: Predicate,
  input: SrsInput,
): RuleEvaluation {
  const trace: RuleEvaluation['trace'] = [];
  const fieldRefs = new Set<string>();
  const reasons = new Set<string>();
  const deadline = performance.now() + 100;
  const check = () => {
    if (performance.now() > deadline)
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '规则执行超时，请缩小输入范围。',
        { details: { reason: 'RULE_BUDGET_EXCEEDED' } },
      );
  };
  const read = (path: string, env: Environment): Value => {
    const split = path.split('.');
    let raw: unknown;
    let stable = path;
    if (split[0] === 'item') {
      raw = env.item?.[split[1] as keyof NonNullable<Environment['item']>];
      stable = `expense_items.${env.item?.id ?? 'missing'}.${split[1]}`;
    } else if (split[0] === 'invoice') {
      raw =
        env.invoice?.[split[1] as keyof NonNullable<Environment['invoice']>];
      stable = `invoices.${env.invoice?.id ?? 'missing'}.${split[1]}`;
    } else if (split[0] === 'external_facts') {
      const fact = env.input.external_facts[split[1] ?? ''];
      if (!fact || fact.state === 'unknown') {
        fieldRefs.add(path);
        return unknown('EXTERNAL_FACT_UNAVAILABLE');
      }
      raw = fact.value;
    } else if (split[0] === 'travel')
      raw = env.input.travel?.[split[1] as 'start_on' | 'end_on'];
    else raw = env.input[path as keyof SrsInput];
    fieldRefs.add(stable);
    const fieldState =
      env.input.field_states[stable] ?? env.input.field_states[path];
    if (
      fieldState &&
      (fieldState.state === 'unavailable' || fieldState.state === 'unmapped')
    )
      return unknown(fieldState.reason ?? fieldState.state);
    const value = toScalar(raw);
    trace.push({
      op: 'field',
      field: stable,
      value:
        typeof value === 'object' && value && !Array.isArray(value)
          ? { kind: value.kind, n: value.n.toString(), d: value.d.toString() }
          : value,
    });
    return {
      known: true,
      value,
      missing: value === null || fieldState?.state === 'missing',
    };
  };
  const values = (node: ValueNode, env: Environment): Value => {
    check();
    if (node.op === 'field') return read(node.path, env);
    if (node.op === 'literal')
      return { known: true, value: toScalar(node.value), missing: false };
    if (node.op === 'multiply') {
      const a = values(node.left, env),
        b = values(node.right, env);
      if (!a.known) return a;
      if (!b.known) return b;
      const an = asNumeric(a.value),
        bn = asNumeric(b.value);
      if (!an || !bn || (an.kind === 'money' && bn.kind === 'money'))
        return unknown('INVALID_MULTIPLY_TYPES');
      return {
        known: true,
        value: numeric(
          an.n * bn.n,
          an.d * bn.d,
          an.kind === 'money' || bn.kind === 'money' ? 'money' : 'decimal',
        ),
        missing: false,
      };
    }
    const collection = env.input[node.collection];
    if (!Array.isArray(collection)) return unknown('COLLECTION_UNAVAILABLE');
    let count = 0n;
    let sum: Numeric = numeric(0n, 1n, 'money');
    for (const row of collection) {
      const nested: Environment =
        node.collection === 'expense_items'
          ? { ...env, item: row as SrsInput['expense_items'][number] }
          : { ...env, invoice: row as SrsInput['invoices'][number] };
      const applicable = node.where ? pred(node.where, nested) : 'true';
      if (applicable === 'unknown') return unknown('UNKNOWN_COLLECTION_FILTER');
      if (applicable === 'false') continue;
      count++;
      if (node.op === 'sum') {
        const value = values(node.value, nested);
        if (!value.known) return value;
        const amount = asNumeric(value.value);
        if (!amount || value.missing) return unknown('SUM_VALUE_MISSING');
        if (count === 1n) sum = numeric(0n, 1n, amount.kind);
        if (sum.kind !== amount.kind) return unknown('SUM_TYPE_MISMATCH');
        sum = numeric(
          sum.n * amount.d + amount.n * sum.d,
          sum.d * amount.d,
          sum.kind,
        );
      }
    }
    if (node.op === 'sum' && collection.length === 0)
      return unknown('REQUIRED_COLLECTION_EMPTY');
    return {
      known: true,
      value: node.op === 'count' ? numeric(count) : sum,
      missing: false,
    };
  };
  const pred = (node: Predicate, env: Environment): Truth => {
    check();
    let truth: Truth;
    if (node.op === 'all' || node.op === 'any') {
      const results = node.args.map((arg) => pred(arg, env));
      truth =
        node.op === 'all'
          ? results.includes('false')
            ? 'false'
            : results.every((v) => v === 'true')
              ? 'true'
              : 'unknown'
          : results.includes('true')
            ? 'true'
            : results.every((v) => v === 'false')
              ? 'false'
              : 'unknown';
    } else if (node.op === 'not') {
      const value = pred(node.arg, env);
      truth =
        value === 'unknown' ? 'unknown' : value === 'true' ? 'false' : 'true';
    } else if (node.op === 'exists') {
      const value = values(node.value, env);
      if (!value.known) {
        reasons.add(value.reason);
        truth = 'unknown';
      } else truth = value.missing ? 'false' : 'true';
    } else if (node.op === 'for_each') {
      const rows = env.input[node.collection];
      const results: Truth[] = [];
      if (!rows.length) {
        reasons.add('REQUIRED_COLLECTION_EMPTY');
        truth = 'unknown';
      } else {
        for (const row of rows) {
          const nested: Environment =
            node.collection === 'expense_items'
              ? { ...env, item: row as SrsInput['expense_items'][number] }
              : { ...env, invoice: row as SrsInput['invoices'][number] };
          const applicable = node.where ? pred(node.where, nested) : 'true';
          if (applicable === 'unknown') results.push('unknown');
          else if (applicable === 'true')
            results.push(pred(node.predicate, nested));
        }
        truth = results.includes('false')
          ? 'false'
          : results.every((v) => v === 'true')
            ? 'true'
            : 'unknown';
      }
    } else if (node.op === 'compare') {
      const left = values(node.left, env),
        right = values(node.right, env);
      if (!left.known || !right.known) {
        if (!left.known) reasons.add(left.reason);
        if (!right.known) reasons.add(right.reason);
        truth = 'unknown';
      } else if (
        left.missing ||
        right.missing ||
        left.value === null ||
        right.value === null
      ) {
        reasons.add('FIELD_MISSING');
        truth = 'unknown';
      } else {
        let result: boolean | undefined;
        const a = asNumeric(left.value),
          b = asNumeric(right.value);
        if (a && b && a.kind === b.kind) {
          const l = a.n * b.d,
            r = b.n * a.d;
          result =
            node.comparator === 'eq'
              ? l === r
              : node.comparator === 'ne'
                ? l !== r
                : node.comparator === 'gt'
                  ? l > r
                  : node.comparator === 'gte'
                    ? l >= r
                    : node.comparator === 'lt'
                      ? l < r
                      : node.comparator === 'lte'
                        ? l <= r
                        : undefined;
        } else if (
          node.comparator === 'in' &&
          Array.isArray(right.value) &&
          typeof left.value === 'string'
        )
          result = right.value.includes(left.value);
        else if (
          typeof left.value === typeof right.value &&
          (typeof left.value === 'string' || typeof left.value === 'boolean')
        ) {
          result =
            node.comparator === 'eq'
              ? left.value === right.value
              : node.comparator === 'ne'
                ? left.value !== right.value
                : undefined;
          if (
            typeof left.value === 'string' &&
            typeof right.value === 'string' &&
            !a &&
            !b
          )
            result =
              node.comparator === 'gt'
                ? left.value > right.value
                : node.comparator === 'gte'
                  ? left.value >= right.value
                  : node.comparator === 'lt'
                    ? left.value < right.value
                    : node.comparator === 'lte'
                      ? left.value <= right.value
                      : result;
        }
        if (result === undefined) {
          reasons.add('COMPARISON_TYPE_MISMATCH');
          truth = 'unknown';
        } else truth = result ? 'true' : 'false';
      }
    } else truth = 'unknown';
    trace.push({ op: node.op, truth });
    return truth;
  };
  const truth = pred(predicate, { input });
  return {
    truth,
    field_refs: [...fieldRefs],
    unknown_reasons: [...reasons],
    trace,
  };
}
export function evaluateRule(
  rule: CompiledRule,
  input: unknown,
): RuleEvaluation {
  return evaluatePredicate(rule.dsl.predicate, SrsInputSchema.parse(input));
}
export function decimalYuanToMinor(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value))
    throw new AppError(
      'VALIDATION_ERROR',
      '金额必须是最多两位小数的十进制字符串。',
    );
  const [whole = '0', fraction = ''] = value.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}
