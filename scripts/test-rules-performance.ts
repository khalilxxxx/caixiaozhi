import { performance } from 'node:perf_hooks';
import { cpus, release, type, machine, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RuleDsl, SrsInput, Truth } from '@caixiaozhi/contracts/rules';
import {
  compileRule,
  evaluateRule,
} from '../packages/finance/src/evaluator.js';
import {
  BASELINE_RULES,
  personalMealsDsl,
} from '../packages/finance/src/rule-seeds.js';
import { canonicalHash } from '../packages/finance/src/hash.js';

// 固定合成输入；不连接数据库、模型或网络，也不替代Agent/HTTP容量验收。
const ruleCount = 100,
  documentCount = 100;
const fixtures: SrsInput[] = Array.from(
  { length: documentCount },
  (_, index) => {
    const items: SrsInput['expense_items'] = Array.from(
      { length: 5 },
      (_, line) => ({
        id: `synthetic-${index}-line-${line}`,
        category: (
          ['meals', 'lodging', 'transport', 'general', 'meals'] as const
        )[line]!,
        source_expense_type: (
          ['meals', 'lodging', 'transport', 'office', 'meals'] as const
        )[line]!,
        amount:
          index % 13 === 0 && line === 0
            ? null
            : {
                amount_minor: (
                  BigInt(index + 1) * 1000n +
                  BigInt(line) * 50000n
                ).toString(),
                currency: 'CNY',
              },
        invoice_refs: [`synthetic-${index}-invoice-${line}`],
        spent_on: '2026-11-04',
        room_nights: line === 1 ? '2.5' : null,
        oa_request_ref: null,
      }),
    );
    const field_states: SrsInput['field_states'] = {};
    if (index % 10 === 0)
      field_states[`invoices.synthetic-${index}-invoice-0.verified`] = {
        state: 'unavailable',
        reason: 'SYNTHETIC_VERIFICATION_PENDING',
      };
    return {
      schema_version: 1,
      document: {
        type: 'expense_claim',
        id: `synthetic-benchmark-${index}`,
        version: 1,
      },
      business_date: '2026-11-05',
      applicant_id: `synthetic-owner-${index}`,
      department_id: 'dept-sales',
      total_amount: items.some((item) => item.amount === null)
        ? null
        : {
            amount_minor: items
              .reduce(
                (sum, item) => sum + BigInt(item.amount!.amount_minor),
                0n,
              )
              .toString(),
            currency: 'CNY',
          },
      expense_items: items,
      invoices: items.map((item, line) => ({
        id: `synthetic-${index}-invoice-${line}`,
        amount: item.amount,
        invoice_number: `SYNTHETIC-${index}-${line}`,
        verified: index % 10 === 0 && line === 0 ? null : index % 4 !== 0,
      })),
      external_facts: {
        oa_approved: {
          value: index % 3 !== 0,
          provenance: 'explicit-fixed-synthetic-fact',
          state: index % 7 === 0 ? 'unknown' : 'known',
        },
      },
      field_states,
    };
  },
);
const definitions: RuleDsl[] = Array.from({ length: ruleCount }, (_, index) => {
  const base =
    index % 4 === 3
      ? personalMealsDsl(
          ['dept-sales'],
          (100000n + BigInt(index) * 1000n).toString(),
        )
      : structuredClone(BASELINE_RULES[index % 4]!.dsl);
  return {
    ...base,
    applicability: {
      ...base.applicability,
      department_ids: ['dept-sales', `synthetic-department-${index}`],
    },
  };
});
const compileStarted = performance.now(),
  rules = definitions.map(compileRule),
  compileElapsed = performance.now() - compileStarted;
if (new Set(rules.map((rule) => rule.compiled_hash)).size !== ruleCount)
  throw new Error('固定规则集并非100个独立编译版本。');
for (const document of fixtures.slice(0, 10))
  for (const rule of rules.slice(0, 10)) evaluateRule(rule, document);
const durations: number[] = [],
  outcomes: Record<Truth, number> = { true: 0, false: 0, unknown: 0 };
const started = performance.now();
for (const document of fixtures)
  for (const rule of rules) {
    const at = performance.now(),
      result = evaluateRule(rule, document);
    durations.push(performance.now() - at);
    outcomes[result.truth]++;
  }
const elapsed = performance.now() - started,
  resultCount = outcomes.true + outcomes.false + outcomes.unknown;
if (resultCount !== 10000 || durations.length !== 10000)
  throw new Error('规则评估结果数不等于10000，性能验收失败。');
durations.sort((a, b) => a - b);
let hardwareModel = machine();
if (process.platform === 'darwin')
  hardwareModel = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], {
    encoding: 'utf8',
  }).trim();
const result = {
  scope:
    '本机纯SRS解释器：100条固定规则×100张固定合成单据，含每次SrsInput校验，不代表模型、HTTP、并发或生产吞吐保证。',
  measured_at: new Date().toISOString(),
  machine: {
    hardware_model: hardwareModel,
    cpu_model: cpus()[0]?.model ?? 'unavailable',
    logical_cpus: cpus().length,
    memory_bytes: totalmem(),
    os: type(),
    os_release: release(),
    arch: process.arch,
  },
  runtime: { node: process.version, v8: process.versions.v8 },
  fixture: {
    rules: ruleCount,
    unique_compiled_rules: new Set(rules.map((rule) => rule.compiled_hash))
      .size,
    documents: documentCount,
    expense_items_per_document: 5,
    invoices_per_document: 5,
    warmup_evaluations: 100,
    rules_hash: canonicalHash(definitions),
    documents_hash: canonicalHash(fixtures),
  },
  result_count: resultCount,
  failed_evaluations: 0,
  outcomes,
  compile_elapsed_ms: compileElapsed,
  evaluate_elapsed_ms: elapsed,
  per_evaluation_ms: {
    p50: durations[Math.floor(durations.length * 0.5)]!,
    p95: durations[Math.floor(durations.length * 0.95)]!,
    p99: durations[Math.floor(durations.length * 0.99)]!,
    max: durations.at(-1)!,
  },
};
const output = new URL(
  '../docs/verification/rules-performance-latest.json',
  import.meta.url,
);
await mkdir(new URL('.', output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, artifact: fileURLToPath(output) }));
