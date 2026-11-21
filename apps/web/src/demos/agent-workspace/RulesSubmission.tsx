import type { ResultCard } from './workspace.js';
import { Badge } from './ui.js';
import {
  initialDocs,
  initialRules,
  type Metric,
  type Scope,
  type SystemKey,
} from '../srs-review/model.js';
import { readRuleCenter } from './rule-center-model.js';
import './rules-submission.css';

export {
  RuleCenterPage as RulesPage,
  RuleCenterPanel as RulesPanel,
} from './RuleCenter.js';

export const RULES_SUBMISSION_KEY = 'rulesSubmission';
type RuleOrigin = 'builtin' | 'personal';
export type RuleMetric = Metric | 'semantic';
export type RuleDocumentType = 'travel' | 'expense' | 'personal';
export interface WorkspaceRule {
  id: string;
  name: string;
  system: SystemKey;
  origin: RuleOrigin;
  scope: Scope;
  metric: RuleMetric;
  thresholdMinor?: number;
  thresholdDays?: number;
  effect: 'block' | 'warn';
  enabled: boolean;
  version: number;
  description: string;
  instruction?: string;
  requiredFields?: string[];
  documentTypes?: RuleDocumentType[];
}
export interface ExpenseLine {
  id: string;
  name: string;
  category: string;
  amountCents: number;
  date: string;
  sourceFileId: string;
  nights?: number;
  start?: string;
  end?: string;
}
export interface ReviewDoc {
  id: string;
  title: string;
  system: SystemKey;
  kind: string;
  documentType?: RuleDocumentType;
  person: string;
  department: string;
  amountCents?: number;
  mealCents?: number;
  hotelNightCents?: number;
  nights?: number;
  days?: number;
  period: string;
  invoiceUnique?: boolean;
  validInvoice?: boolean | null;
  attachment: boolean;
  version: number;
  stage: string;
  categories: ('hotel' | 'meal')[];
  hotelLines?: ExpenseLine[];
}
export interface RuleFinding {
  rule: WorkspaceRule;
  state: 'hit' | 'unknown';
  actual: string;
  expected: string;
  detail: string;
  evidence?: { path: string; quote: string }[];
  executed?: boolean;
}
export interface RuleEvaluation {
  ruleId: string;
  state: 'MATCHED' | 'NOT_MATCHED' | 'INSUFFICIENT_EVIDENCE';
  reason: string;
  evidence: { path: string; quote: string }[];
}
export interface RuleReview {
  engine?: string;
  model?: string;
  evaluatedAt?: string;
  evaluations?: RuleEvaluation[];
  status: 'attention' | 'unknown' | 'clear';
  findings: RuleFinding[];
  passed: WorkspaceRule[];
  inapplicable: WorkspaceRule[];
  applicable: WorkspaceRule[];
}
interface RuleForm {
  id?: string;
  name: string;
  system: SystemKey;
  scope: Scope;
  metric: RuleMetric;
  threshold: string;
}
export interface RulesSubmissionState {
  rules: WorkspaceRule[];
  reviewedRules: WorkspaceRule[];
  reviewedAt: Record<SystemKey, string>;
  notes: Record<string, string>;
  schedule: {
    enabled: boolean;
    time: string;
    lastRunAt?: string;
    lastRunDate?: string;
  };
  ruleForms: Record<string, RuleForm>;
  reviewResults?: Record<
    string,
    {
      documentVersion: number;
      signature: string;
      review: RuleReview;
      checkedAt?: string;
    }
  >;
  auditFilter: 'all' | 'attention' | 'unknown' | 'clear';
}
const metricLabels: Record<RuleMetric, string> = {
  semantic: '业务语义',
  amount: '单据金额',
  meal: '餐饮合计',
  hotelNight: '住宿单价',
  days: '申请天数',
  invoiceUnique: '发票重复',
  validInvoice: '发票有效性',
  attachment: '附件完整性',
};
const cloneRules = (rules: WorkspaceRule[]) =>
  rules
    .filter((rule) => rule.metric !== 'validInvoice')
    .map((rule) => ({ ...rule }));
const normalizedRules: WorkspaceRule[] = initialRules.map(
  ({ threshold, ...rule }) => ({
    ...rule,
    ...(threshold === undefined
      ? {}
      : rule.metric === 'days'
        ? { thresholdDays: threshold }
        : { thresholdMinor: Math.round(threshold * 100) }),
  }),
);
export const AUDIT_DOCUMENTS: ReviewDoc[] = initialDocs.map(
  ({ amount, meal, hotelNight, ...doc }) => ({
    ...doc,
    ...(amount === undefined ? {} : { amountCents: Math.round(amount * 100) }),
    ...(meal === undefined ? {} : { mealCents: Math.round(meal * 100) }),
    ...(hotelNight === undefined
      ? {}
      : { hotelNightCents: Math.round(hotelNight * 100) }),
    categories: [
      ...(hotelNight !== undefined ? ['hotel' as const] : []),
      ...(meal !== undefined ? ['meal' as const] : []),
    ],
  }),
);
export const INITIAL_RULES_SUBMISSION: RulesSubmissionState = {
  rules: cloneRules(normalizedRules),
  reviewedRules: cloneRules(normalizedRules),
  reviewedAt: { expense: '11月16日 08:30', oa: '11月16日 08:30' },
  notes: {},
  schedule: { enabled: true, time: '08:30' },
  ruleForms: {},
  auditFilter: 'all',
};
export const formatCents = (value: number) =>
  '¥' +
  (value / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export function parseCents(text: string): number | null {
  const match = text.trim().match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!match) return null;
  const amount =
    Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(amount) && amount <= 10000000000 ? amount : null;
}
function ruleValue(rule: WorkspaceRule) {
  return rule.metric === 'days'
    ? `${rule.thresholdDays}天`
    : formatCents(rule.thresholdMinor || 0) +
        (rule.metric === 'hotelNight' ? '/间夜' : '');
}
export function workspaceRuleCondition(rule: WorkspaceRule) {
  return rule.thresholdMinor !== undefined || rule.thresholdDays !== undefined
    ? `${metricLabels[rule.metric]} > ${ruleValue(rule)}`
    : rule.description;
}
export function ruleSignature(
  rules: WorkspaceRule[],
  scope: 'submit' | 'review',
  system: SystemKey,
) {
  return JSON.stringify(
    rules
      .filter(
        (r) =>
          r.metric !== 'validInvoice' &&
          r.enabled &&
          r.system === system &&
          (r.scope === scope || r.scope === 'both'),
      )
      // Rule IDs are ASCII; compare code points to match Python sorted.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        id: r.id,
        name: r.name,
        system: r.system,
        origin: r.origin,
        scope: r.scope,
        metric: r.metric,
        thresholdMinor: r.thresholdMinor,
        thresholdDays: r.thresholdDays,
        effect: r.effect,
        enabled: r.enabled,
        version: r.version,
        description: r.description,
        instruction: r.instruction,
        requiredFields: r.requiredFields,
        documentTypes: r.documentTypes,
      })),
  );
}
export function evaluateWorkspaceRules(
  doc: ReviewDoc,
  rules: WorkspaceRule[],
  scope: 'submit' | 'review' = 'review',
): RuleReview {
  const findings: RuleFinding[] = [],
    passed: WorkspaceRule[] = [],
    inapplicable: WorkspaceRule[] = [],
    applicable: WorkspaceRule[] = [];
  const documentType =
    doc.documentType ??
    (doc.system === 'oa'
      ? ['出差申请', '差旅申请'].includes(doc.kind)
        ? 'travel'
        : undefined
      : ['费用报销', '个人费用报销'].includes(doc.kind)
        ? 'personal'
        : 'expense');
  for (const rule of rules) {
    if (
      rule.metric === 'validInvoice' ||
      !rule.enabled ||
      rule.system !== doc.system ||
      !(rule.scope === 'both' || rule.scope === scope)
    )
      continue;
    if (
      (rule.documentTypes?.length &&
        (!documentType || !rule.documentTypes.includes(documentType))) ||
      (rule.metric === 'hotelNight' && !doc.categories.includes('hotel')) ||
      (rule.metric === 'meal' && !doc.categories.includes('meal'))
    ) {
      inapplicable.push(rule);
      continue;
    }
    applicable.push(rule);
    if (rule.metric === 'semantic') {
      findings.push({
        rule,
        state: 'unknown',
        actual: '尚未执行语义检查',
        expected: rule.instruction || rule.description,
        detail: '尚无服务端语义检查结果，请重新检查。',
        evidence: [],
      });
      continue;
    }
    const value: number | boolean | null | undefined =
      rule.metric === 'amount'
        ? doc.amountCents
        : rule.metric === 'meal'
          ? doc.mealCents
          : rule.metric === 'hotelNight'
            ? doc.hotelNightCents
            : rule.metric === 'days'
              ? doc.days
              : rule.metric === 'invoiceUnique'
                ? doc.invoiceUnique
                : doc.attachment;
    if (value === undefined || value === null) {
      findings.push({
        rule,
        state: 'unknown',
        actual: '尚未取得必要数据',
        expected: workspaceRuleCondition(rule),
        detail: '当前缺少' + metricLabels[rule.metric] + '，请补全后重新检查。',
      });
      continue;
    }
    const threshold =
      rule.metric === 'days' ? rule.thresholdDays : rule.thresholdMinor;
    if (
      threshold !== undefined &&
      typeof value === 'number' &&
      value > threshold
    ) {
      const actual =
        rule.metric === 'days'
          ? value + '天'
          : formatCents(value) + (rule.metric === 'hotelNight' ? '/间夜' : '');
      findings.push({
        rule,
        state: 'hit',
        actual,
        expected:
          rule.origin === 'personal'
            ? '超过' + ruleValue(rule) + '时提醒'
            : '不超过' + ruleValue(rule),
        detail:
          rule.origin === 'builtin' && rule.metric === 'hotelNight'
            ? doc.hotelLines
              ? `本单${doc.hotelLines.length}项住宿中，${doc.hotelLines.filter((l) => l.amountCents > threshold * (l.nights || 1)).length}项超出标准，合计超出${formatCents(doc.hotelLines.reduce((n, l) => n + Math.max(0, l.amountCents - threshold * (l.nights || 1)), 0))}。`
              : `${doc.nights || 1}间夜住宿合计${formatCents(value * (doc.nights || 1))}，超出标准${formatCents((value - threshold) * (doc.nights || 1))}。`
            : rule.origin === 'personal'
              ? '达到个人提醒条件，不影响通用规则和正式审批。'
              : rule.effect === 'block'
                ? scope === 'submit'
                  ? '超出公司标准，请处理超限问题后再提交。'
                  : '超出公司标准，请核实并处理超限问题。'
                : '达到公司提醒条件，请核对相关费用。',
      });
      continue;
    }
    if (value === false) {
      findings.push({
        rule,
        state: 'hit',
        actual:
          rule.metric === 'invoiceUnique'
            ? '发票尾号6739已关联其他单据'
            : '缺少必要凭证',
        expected: rule.description,
        detail:
          rule.metric === 'invoiceUnique'
            ? '已关联BX-20261109-018，关联金额¥680.00。请核对原始报销记录。'
            : '请补充或更正材料后重新检查。',
      });
      continue;
    }
    passed.push(rule);
  }
  return {
    status: findings.some((f) => f.state === 'hit')
      ? 'attention'
      : findings.length
        ? 'unknown'
        : 'clear',
    findings,
    passed,
    inapplicable,
    applicable,
  };
}
function readData(data: Record<string, any>): RulesSubmissionState {
  return data[RULES_SUBMISSION_KEY] ?? INITIAL_RULES_SUBMISSION;
}
export function readAuditReview(doc: ReviewDoc, state: RulesSubmissionState) {
  const saved = state.reviewResults?.[doc.id];
  const signature = ruleSignature(state.rules, 'review', doc.system);
  const current = Boolean(
    saved &&
    saved.documentVersion === doc.version &&
    saved.signature === signature,
  );
  if (current && saved)
    return {
      review: saved.review,
      stale: false,
      checked: true,
      checkedAt: saved.checkedAt,
    };
  const { applicable, inapplicable } = evaluateWorkspaceRules(doc, state.rules);
  const review: RuleReview = {
    status: 'unknown',
    passed: [],
    inapplicable,
    applicable,
    findings: applicable.map((rule) => ({
      rule,
      state: 'unknown',
      actual: saved ? '检查依据已变化' : '尚未检查',
      expected: workspaceRuleCondition(rule),
      detail: saved
        ? '单据或适用规则已更新，请重新审查。'
        : '尚无服务端预审结果，请执行审查。',
      evidence: [],
    })),
  };
  return {
    review,
    stale: Boolean(saved),
    checked: false,
    checkedAt: saved?.checkedAt,
  };
}
export function getAuditSummary(data: Record<string, any>): ResultCard {
  const s = readData(data),
    counts = { attention: 0, unknown: 0, clear: 0 };
  const records = (data.auditDocuments ?? []) as ReviewDoc[];
  const audits = records.map((doc) => readAuditReview(doc, s));
  for (const { review } of audits) counts[review.status]++;
  const stale = audits.some((audit) => audit.stale);
  return {
    kind: 'audit',
    id: 'batch',
    title: '待办预审',
    subtitle: `费用报销${records.filter((item) => item.system === 'expense').length} · OA办公${records.filter((item) => item.system === 'oa').length} · 需关注${counts.attention} · 待核实${counts.unknown}`,
    status: `${records.length}张待办`,
    data: { ...counts, stale },
  };
}
export function getRuleSummary(data: Record<string, any>): ResultCard {
  const { rules } = readRuleCenter(data);
  const company = rules.filter((r) => r.origin === 'builtin');
  const personal = rules.filter((r) => r.origin === 'personal');
  return {
    kind: 'rule',
    id: 'list',
    title: '规则中心',
    subtitle: `公司规则${company.length}项（启用${company.filter((r) => r.enabled).length}） · 个人规则${personal.length}项（启用${personal.filter((r) => r.enabled).length}）`,
    status: '本地规则库',
  };
}
export function RuleEvaluationResults({ review }: { review: RuleReview }) {
  if (!review.evaluations?.length) return null;
  return (
    <details className="rs-source">
      <summary>语义检查明细 · {review.evaluations.length} 项</summary>
      {review.evaluations.map((evaluation) => (
        <section key={evaluation.ruleId}>
          <strong>
            {review.applicable.find((rule) => rule.id === evaluation.ruleId)
              ?.name || evaluation.ruleId}
          </strong>
          <Badge
            tone={
              evaluation.state === 'MATCHED'
                ? 'warning'
                : evaluation.state === 'NOT_MATCHED'
                  ? 'success'
                  : 'neutral'
            }
          >
            {evaluation.state === 'MATCHED'
              ? '命中'
              : evaluation.state === 'NOT_MATCHED'
                ? '未命中'
                : '待核实'}
          </Badge>
          <p>{evaluation.reason}</p>
          {evaluation.evidence.length ? (
            evaluation.evidence.map((evidence, index) => (
              <p key={evidence.path + index}>
                <code>{evidence.path}</code> · {evidence.quote}
              </p>
            ))
          ) : (
            <small>暂无可引用的原文证据</small>
          )}
        </section>
      ))}
    </details>
  );
}
