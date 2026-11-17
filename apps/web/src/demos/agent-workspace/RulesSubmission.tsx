import { businessTime } from './time-format';
import { api } from './runtime-client';
import { useEffect, useState } from 'react';
import {
  useSlice,
  useWorkspace,
  type PanelSpec,
  type ResultCard,
} from './workspace.js';
import { Badge, Button, Empty, Field, Icon } from './ui.js';
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
const systemLabels: Record<SystemKey, string> = {
  expense: '费用报销',
  oa: 'OA办公',
};
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
const statusLabels = {
  attention: '需关注',
  unknown: '待核实',
  clear: '未发现异常',
};
const currentUser = { name: '林悦', department: '财务部' };
const now = () =>
  new Date().toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
function useData() {
  return useSlice<RulesSubmissionState>(
    RULES_SUBMISSION_KEY,
    INITIAL_RULES_SUBMISSION,
  );
}
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
  records.forEach((d) => counts[readAuditReview(d, s).review.status]++);
  const stale = records.some((doc) => readAuditReview(doc, s).stale);
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
const rulePanel = (
  id: string,
  title: string,
  data?: Record<string, any>,
): PanelSpec => ({ kind: 'rule', id, title, data });
const auditPanel = (id = 'batch'): PanelSpec => ({
  kind: 'audit',
  id,
  title:
    id === 'batch'
      ? '待办预审'
      : AUDIT_DOCUMENTS.find((d) => d.id === id)?.title || '单据审查',
});

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

function ReviewFindings({
  review,
  onRule,
}: {
  review: RuleReview;
  onRule?: (rule: WorkspaceRule) => void;
}) {
  return (
    <div className="rs-findings">
      {review.findings.map((f) => (
        <section className="rs-finding" key={f.rule.id}>
          <div className="rs-finding-head">
            <Icon name={f.state === 'unknown' ? 'clock' : 'alert'} size={16} />
            <h4>{f.rule.name}</h4>
            <Badge
              tone={
                f.state === 'unknown'
                  ? 'neutral'
                  : f.rule.effect === 'block'
                    ? 'warning'
                    : 'info'
              }
            >
              {f.state === 'unknown'
                ? '待核实'
                : f.rule.origin === 'personal'
                  ? '个人提醒'
                  : '需处理'}
            </Badge>
          </div>
          <p>{f.detail}</p>
          {f.evidence?.length ? (
            <details className="rs-source">
              <summary>执行证据</summary>
              {f.evidence.map((e, index) => (
                <p key={e.path + index}>
                  <code>{e.path}</code> · {e.quote}
                </p>
              ))}
            </details>
          ) : f.rule.metric === 'semantic' ? (
            <small>暂无可引用的原文证据</small>
          ) : null}
          <div className="rs-compare">
            <div>
              <span>实际情况</span>
              <strong>{f.actual}</strong>
            </div>
            <div>
              <span>规则要求</span>
              <strong>{f.expected}</strong>
            </div>
          </div>
          <details className="rs-source">
            <summary>
              规则依据{' '}
              <span>
                {f.rule.id} · v{f.rule.version}
              </span>
            </summary>
            <p>{f.rule.description}</p>
            {onRule && (
              <Button variant="ghost" onClick={() => onRule(f.rule)}>
                查看规则
              </Button>
            )}
          </details>
        </section>
      ))}
      <RuleEvaluationResults review={review} />
      {!review.findings.length &&
        review.status === 'clear' &&
        review.applicable.length > 0 && (
          <div className="rs-clear">
            <Icon name="check" size={18} />
            <span>适用规则检查完成，未发现异常</span>
          </div>
        )}
      {!review.findings.length && review.status === 'unknown' && (
        <p>尚无当前版本的审查结果，请重新审查。</p>
      )}
      {!review.applicable.length && review.status === 'clear' && (
        <p>当前单据无适用规则</p>
      )}
      {review.engine && (
        <div className="rs-check-meta">
          {review.engine}
          {review.model ? ` · ${review.model}` : ''}
        </div>
      )}
      <details className="rs-passed">
        <summary>
          已通过 {review.passed.length} 项检查
          <Icon name="down" size={14} />
        </summary>
        {review.passed.map((r) => (
          <div key={r.id}>
            <Icon name="check" size={14} />
            {r.name}
            <span>v{r.version}</span>
          </div>
        ))}
      </details>
      {review.inapplicable.length > 0 && (
        <details className="rs-passed">
          <summary>
            {review.inapplicable.length} 项不适用
            <Icon name="down" size={14} />
          </summary>
          {review.inapplicable.map((r) => (
            <div key={r.id}>
              {r.name}
              <span>当前单据不适用</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
export function AuditPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [s, set] = useData(),
    id = panel.id || 'batch';
  const [tab, setTab] = useState<'review' | 'fields'>('review'),
    [note, setNote] = useState(''),
    [noteEditing, setNoteEditing] = useState(false);
  const records = (w.state.data.auditDocuments ?? []) as ReviewDoc[];
  const [checking, setChecking] = useState(false);
  const doc = records.find((d) => d.id === id);
  useEffect(() => {
    setTab('review');
    setNote(s.notes[id] || '');
    setNoteEditing(false);
  }, [id]);
  const counts = { attention: 0, unknown: 0, clear: 0 };
  records.forEach((d) => counts[readAuditReview(d, s).review.status]++);
  const recheck = async (system?: SystemKey) => {
    if (checking) return;
    setChecking(true);
    try {
      await w.flush();
      await api('/business/preaudit', system ? { system } : {});
      await w.refresh();
      w.notify('审查结果已更新');
    } catch (error) {
      w.notify(error instanceof Error ? error.message : '预审失败，请重试');
    } finally {
      setChecking(false);
    }
  };
  if (id === 'schedule') return <SchedulePanel />;
  if (id === 'batch')
    return (
      <div className="rs-panel">
        <div className="rs-batch-stats">
          <div>
            <strong>{records.length}</strong>
            <span>待办单据</span>
          </div>
          <div>
            <strong>{counts.attention}</strong>
            <span>需关注</span>
          </div>
          <div>
            <strong>{counts.unknown}</strong>
            <span>待核实</span>
          </div>
          <div>
            <strong>{counts.clear}</strong>
            <span>未发现异常</span>
          </div>
        </div>
        <div className="tabs rs-audit-tabs">
          {(['all', 'attention', 'unknown', 'clear'] as const).map((key) => (
            <button
              key={key}
              className={s.auditFilter === key ? 'active' : ''}
              onClick={() => set((p) => ({ ...p, auditFilter: key }))}
            >
              {key === 'all' ? '全部' : statusLabels[key]}
            </button>
          ))}
        </div>
        <div className="rs-compact-list">
          {records
            .filter(
              (d) =>
                s.auditFilter === 'all' ||
                readAuditReview(d, s).review.status === s.auditFilter,
            )
            .map((d) => {
              const { review, stale } = readAuditReview(d, s);
              return (
                <button
                  key={d.id}
                  onClick={() => w.openPanel(auditPanel(d.id))}
                >
                  <span className="rs-item-icon">
                    <Icon
                      name={d.system === 'oa' ? 'tasks' : 'file'}
                      size={20}
                    />
                  </span>
                  <span>
                    <strong>{d.title}</strong>
                    <small>
                      {systemLabels[d.system]} · {d.person} ·{' '}
                      {d.amountCents === undefined
                        ? d.days + '天'
                        : formatCents(d.amountCents)}
                    </small>
                  </span>
                  <Badge
                    tone={
                      stale
                        ? 'warning'
                        : review.status === 'clear'
                          ? 'success'
                          : review.status === 'attention'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {stale ? '结果待更新' : statusLabels[review.status]}
                  </Badge>
                  <Icon name="chevron" size={15} />
                </button>
              );
            })}
        </div>
        <div className="rs-panel-actions">
          <Button
            variant="ghost"
            icon="clock"
            onClick={() =>
              w.openPanel({ kind: 'audit', id: 'schedule', title: '定时预审' })
            }
          >
            预审设置
          </Button>
          <Button
            icon="link"
            onClick={() => {
              w.attach({ kind: 'audit', id: 'batch', title: '待办预审' });
              w.closePanel();
              w.navigate('chat');
            }}
          >
            加入对话
          </Button>
          <Button
            variant="primary"
            icon="refresh"
            disabled={checking}
            onClick={() => recheck()}
          >
            重新审查
          </Button>
        </div>
      </div>
    );
  if (!doc) return <Empty title="单据不存在" />;
  const { review, stale, checked, checkedAt } = readAuditReview(doc, s);
  return (
    <div className="rs-panel">
      <Button
        variant="ghost"
        icon="back"
        onClick={() => w.openPanel(auditPanel())}
      >
        返回预审列表
      </Button>
      <div className="rs-audit-overview">
        <div>
          <span>
            {doc.person} · {doc.department}
          </span>
          <strong>
            {doc.amountCents === undefined
              ? doc.days + '天'
              : formatCents(doc.amountCents)}
          </strong>
        </div>
        <Badge>{doc.stage}</Badge>
      </div>
      <div className="tabs">
        <button
          className={tab === 'review' ? 'active' : ''}
          onClick={() => setTab('review')}
        >
          审查结果
        </button>
        <button
          className={tab === 'fields' ? 'active' : ''}
          onClick={() => setTab('fields')}
        >
          单据信息
        </button>
      </div>
      {stale && (
        <div className="rs-notice warning">
          <Icon name="alert" size={16} />
          单据或适用规则已更新，结果待更新。
        </div>
      )}
      {tab === 'review' ? (
        <>
          <div className="rs-check-meta">
            <Badge
              tone={
                review.status === 'clear'
                  ? 'success'
                  : review.status === 'attention'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {statusLabels[review.status]}
            </Badge>
            <span>
              {checked
                ? businessTime(
                    checkedAt || review.evaluatedAt || s.reviewedAt[doc.system],
                  )
                : '尚未完成当前版本审查'}{' '}
              · {review.applicable.length}项规则
            </span>
          </div>
          <ReviewFindings
            review={review}
            onRule={(r) =>
              w.openPanel(rulePanel(r.id, '规则详情', { fromAudit: doc.id }))
            }
          />
        </>
      ) : (
        <dl className="rs-definition">
          <dt>单据编号</dt>
          <dd>{doc.id}</dd>
          <dt>所属系统</dt>
          <dd>{systemLabels[doc.system]}</dd>
          <dt>单据类型</dt>
          <dd>{doc.kind}</dd>
          <dt>业务日期</dt>
          <dd>{doc.period}</dd>
          <dt>业务状态</dt>
          <dd>{doc.stage}</dd>
          <dt>关联材料</dt>
          <dd>{doc.attachment ? '已关联' : '待补充'}</dd>
          <dt>单据版本</dt>
          <dd>v{doc.version}</dd>
        </dl>
      )}
      {noteEditing ? (
        <div className="rs-note-form">
          <Field label="审核备注">
            <textarea
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="填写核实情况或处理说明"
            />
          </Field>
          <div className="rs-inline-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setNote(s.notes[id] || '');
                setNoteEditing(false);
              }}
            >
              取消
            </Button>
            <Button
              onClick={async () => {
                set((p) => ({
                  ...p,
                  notes: { ...p.notes, [id]: note.trim() },
                }));
                setNoteEditing(false);
                try {
                  await w.flush();
                  w.notify('审核备注已保存');
                } catch (error) {
                  w.notify(
                    error instanceof Error ? error.message : '审核备注保存失败',
                  );
                }
              }}
            >
              保存备注
            </Button>
          </div>
        </div>
      ) : (
        s.notes[id] && (
          <div className="rs-saved-note">
            <strong>审核备注</strong>
            <p>{s.notes[id]}</p>
            <small>{currentUser.name} · 当前单据</small>
          </div>
        )
      )}
      <div className="rs-panel-actions">
        <Button
          variant="ghost"
          icon="edit"
          onClick={() => setNoteEditing(true)}
        >
          审核备注
        </Button>
        <span className="rs-grow" />
        <Button
          icon="link"
          onClick={() => {
            w.attach({
              kind: 'audit',
              id: doc.id,
              title: doc.title,
              version: 'v' + doc.version,
            });
            w.closePanel();
            w.navigate('chat');
          }}
        >
          加入对话
        </Button>
        <Button
          variant="primary"
          icon="refresh"
          disabled={checking}
          onClick={() => recheck(doc.system)}
        >
          重新审查
        </Button>
      </div>
    </div>
  );
}
function SchedulePanel() {
  const w = useWorkspace(),
    [s, set] = useData();
  const [enabled, setEnabled] = useState(s.schedule.enabled),
    [time, setTime] = useState(s.schedule.time),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="rs-panel">
      <label className="rs-toggle-row">
        <span>每日预审待办</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>
      <Field label="执行时间 · 北京时间">
        <input
          type="time"
          value={time}
          required
          onChange={(e) => setTime(e.target.value)}
        />
      </Field>
      <dl className="rs-definition">
        <dt>预审范围</dt>
        <dd>费用报销、OA办公 · 待本人审核</dd>
        <dt>运行状态</dt>
        <dd>
          {s.schedule.lastRunAt
            ? `上次执行：${new Date(s.schedule.lastRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
            : s.schedule.enabled
              ? '已启用，等待首次执行'
              : '未启用'}
        </dd>
      </dl>
      {error && (
        <p className="rs-error" role="alert">
          {error}
        </p>
      )}
      <div className="rs-panel-actions">
        <Button
          variant="primary"
          disabled={!time || saving}
          onClick={async () => {
            setSaving(true);
            setError('');
            set((p) => ({ ...p, schedule: { ...p.schedule, enabled, time } }));
            try {
              await w.flush();
              await w.refresh();
              w.closePanel();
              w.notify('预审设置已保存');
            } catch (error) {
              setError(
                error instanceof Error ? error.message : '预审设置保存失败',
              );
            } finally {
              setSaving(false);
            }
          }}
        >
          保存
        </Button>
      </div>
    </div>
  );
}
