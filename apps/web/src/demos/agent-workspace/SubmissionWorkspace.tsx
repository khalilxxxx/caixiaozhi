import { businessTime } from './time-format';
import { useEffect, useRef, useState } from 'react';
import {
  useSlice,
  useWorkspace,
  type PanelSpec,
  type ResultCard,
} from './workspace.js';
import { Badge, Button, Empty, Icon, Money, Section } from './ui.js';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import {
  INITIAL_RULES_SUBMISSION,
  RULES_SUBMISSION_KEY,
  RuleEvaluationResults,
  evaluateWorkspaceRules,
  type RuleReview,
  type RulesSubmissionState,
  type WorkspaceRule,
} from './RulesSubmission.js';
import {
  draftPeriod,
  getDraftType,
  submissionLabels,
  draftCurrencyTotals,
  draftTotal,
  expenseNights,
  getExpenseCategory,
  affectedMaterialDrafts,
  amountCents as parseCents,
  validateDraft,
  type DraftId,
  type MaterialExpenseImport,
  type SubmissionDraft,
  type ValidationIssue,
} from './submission-model.js';
import { SubmissionFields } from './SubmissionFields.js';
import { SubmissionDefaults } from './SubmissionDefaults';
import { activeSubmissionDefaults } from './submission-defaults';
import { materialsInitial } from './Documents.js';
import {
  SUBMISSIONS_KEY,
  applyMaterialBatch,
  draftIds,
  readSubmissionState as readStoredSubmissions,
  resolveDraftId,
  type SubmissionRequest as StoredSubmissionRequest,
  type SubmissionState as StoredSubmissionState,
} from './submission-state.js';
export { SUBMISSIONS_KEY } from './submission-state.js';
import './submission.css';
import './submission-expense-shell.css';
import { api } from './runtime-client';
import {
  beginSubmissionAttempt, clearSubmissionAttempt, recordSubmissionReceipt,
  submitWasRejected, useSubmissionAttempt, type SubmissionAttempt,
} from './submission-attempt';

export { submissionLabels } from './submission-model.js';

interface SubmissionCheck {
  version: number;
  signature: string;
  checkedAt: string;
  issues: ValidationIssue[];
  review: RuleReview;
}

type SubmissionRequest = StoredSubmissionRequest<SubmissionCheck>;
type SubmissionState = StoredSubmissionState<SubmissionCheck>;

const emptyReview: RuleReview = {
  status: 'clear',
  findings: [],
  passed: [],
  inapplicable: [],
  applicable: [],
};

function stamp() {
  return new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function submissionPanel(
  id: DraftId,
  data?: Record<string, unknown>,
): PanelSpec {
  return {
    kind: 'submission',
    id,
    title:
      data?.step === 'confirm'
        ? '确认提交'
        : submissionLabels[getDraftType(id)],
    data,
  };
}

export function readSubmissionState(
  data: Record<string, any>,
): SubmissionState {
  return readStoredSubmissions<SubmissionCheck>(data, materialsInitial.files);
}

function useSubmissionData() {
  const workspace = useWorkspace();
  return useSlice<SubmissionState>(
    SUBMISSIONS_KEY,
    readSubmissionState(workspace.state.data),
  );
}

export function applicableRules(
  id: DraftId | SubmissionDraft,
  rules: WorkspaceRule[],
) {
  const documentType = getDraftType(id);
  return rules.filter(
    (rule) =>
      rule.metric !== 'validInvoice' &&
      (documentType !== 'travel' ||
        rule.metric === 'days' ||
        rule.metric === 'semantic') &&
      (!rule.documentTypes?.length ||
        rule.documentTypes.includes(documentType)),
  );
}

export function checkSignature(
  id: DraftId | SubmissionDraft,
  rules: WorkspaceRule[],
) {
  const system = getDraftType(id) === 'travel' ? 'oa' : 'expense';
  // Match the server's rule signature, including the semantic rule inputs.
  const keys = [
    'id',
    'name',
    'system',
    'origin',
    'scope',
    'metric',
    'thresholdMinor',
    'thresholdDays',
    'effect',
    'enabled',
    'version',
    'description',
    'instruction',
    'requiredFields',
    'documentTypes',
  ];
  return JSON.stringify(
    applicableRules(id, rules)
      .filter(
        (rule) =>
          rule.enabled &&
          rule.system === system &&
          (rule.scope === 'both' || rule.scope === 'submit'),
      )
      // Rule IDs are ASCII; compare code points to match Python sorted.
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((rule) =>
        Object.fromEntries(
          keys
            .filter((key) => key in rule)
            .map((key) => [
              key,
              (rule as unknown as Record<string, unknown>)[key],
            ]),
        ),
      ),
  );
}

function isCheckCurrent(
  draft: SubmissionDraft,
  check: SubmissionCheck | undefined,
  rules: WorkspaceRule[],
) {
  return Boolean(
    check &&
    check.version === draft.version &&
    check.signature === checkSignature(draft, rules),
  );
}

export function hasBlockingIssues(check: SubmissionCheck | undefined) {
  return (
    !check ||
    check.issues.length > 0 ||
    check.review.findings.some(
      (finding) =>
        finding.rule.effect === 'block' ||
        (finding.state === 'unknown' && finding.rule.metric !== 'semantic'),
    )
  );
}

function isDirty(current: SubmissionDraft, saved: SubmissionDraft) {
  return JSON.stringify(current) !== JSON.stringify(saved);
}

function reviewDraft(
  draft: SubmissionDraft,
  rules: WorkspaceRule[],
): RuleReview {
  const hotels = draft.expenses.filter(
    (item) => getExpenseCategory(item.categoryId)?.template === 'T03',
  );
  const meals = draft.expenses.filter(
    (item) => getExpenseCategory(item.categoryId)?.template === 'T05',
  );
  const roomNights = (item: (typeof hotels)[number]) => {
    const rooms = Number(item.rooms);
    return rooms > 0 ? expenseNights(item) * rooms : 0;
  };
  const period = draftPeriod(draft);
  const currenciesKnown = draft.expenses.every(
    (item) => item.currency === 'CNY',
  );
  const days =
    period.start && period.end
      ? Math.round(
          (Date.parse(period.end) - Date.parse(period.start)) / 86400000,
        ) + 1
      : undefined;
  return evaluateWorkspaceRules(
    {
      id: draft.id,
      title: draft.title,
      system: getDraftType(draft) === 'travel' ? 'oa' : 'expense',
      kind: submissionLabels[getDraftType(draft)],
      documentType: getDraftType(draft),
      person: draft.applicant,
      department: draft.department,
      amountCents:
        getDraftType(draft) === 'travel' || !currenciesKnown
          ? undefined
          : draftTotal(draft),
      mealCents: meals.every((item) => item.currency === 'CNY')
        ? meals.reduce((sum, item) => sum + (parseCents(item.amount) ?? 0), 0)
        : undefined,
      hotelNightCents:
        hotels.length &&
        hotels.every((item) => item.currency === 'CNY' && roomNights(item) > 0)
          ? Math.max(
              ...hotels.map(
                (item) => (parseCents(item.amount) ?? 0) / roomNights(item),
              ),
            )
          : undefined,
      hotelLines: hotels.map((item) => ({
        id: item.id,
        name: item.name,
        category: '住宿',
        date: item.checkIn || item.date,
        sourceFileId: item.sourceFileId ?? '',
        amountCents: parseCents(item.amount) ?? 0,
        nights: roomNights(item),
      })),
      nights: hotels.reduce((sum, item) => sum + roomNights(item), 0),
      days,
      period: [period.start, period.end].filter(Boolean).join(' — '),
      invoiceUnique: draft.invoiceUnique,
      attachment:
        draft.files.length > 0 ||
        draft.expenses.every((item) => item.files.length > 0),
      version: draft.version,
      stage: draft.status === 'draft' ? '草稿' : '待回执',
      categories: [
        ...(hotels.length ? ['hotel' as const] : []),
        ...(meals.length ? ['meal' as const] : []),
      ],
    },
    applicableRules(draft, rules),
    'submit',
  );
}

function amountLabel(draft: SubmissionDraft) {
  return (
    draftCurrencyTotals(draft)
      .map((item) => `${item.currency} ${(item.amountCents / 100).toFixed(2)}`)
      .join(' · ') || '金额待补充'
  );
}

function DraftAmount({ draft }: { draft: SubmissionDraft }) {
  const totals = draftCurrencyTotals(draft);
  if (!totals.length) return <span className="sf-amount-pending">待补充</span>;
  return (
    <span className="sf-currency-amounts">
      {totals.map((item) => (
        <span key={item.currency}>
          {item.currency === 'CNY' ? (
            <Money value={item.amountCents} />
          ) : (
            `${item.currency} ${(item.amountCents / 100).toFixed(2)}`
          )}
        </span>
      ))}
    </span>
  );
}

export function getSubmissionSummary(
  data: Record<string, any>,
  id: DraftId = 'expense',
): ResultCard {
  const state = readSubmissionState(data);
  const saved = state.drafts[id];
  if (!saved)
    return {
      kind: 'submission',
      id,
      title: '单据不存在',
      status: '不可用',
      tone: 'warning',
    };
  const draft = state.edits[id] ?? saved;
  const issues = validateDraft(draft, { submit: true });
  const rules = (data[RULES_SUBMISSION_KEY] ?? INITIAL_RULES_SUBMISSION)
    .rules as WorkspaceRule[];
  const check = state.checks[id];
  const dirty = isDirty(draft, saved);
  const current = isCheckCurrent(saved, check, rules);
  let status = '草稿';
  if (saved.status === 'awaiting_receipt')
    status = state.requests.some(
      (request) => request.draftId === id && request.localStatus,
    )
      ? '本地已受理'
      : '待回执';
  else if (dirty) status = '有未保存更改';
  else if (check && !current) status = '需重新检查';
  else if (current) status = hasBlockingIssues(check) ? '待完善' : '待确认提交';
  return {
    kind: 'submission',
    id,
    title: draft.title,
    subtitle: `${submissionLabels[getDraftType(id)]}${getDraftType(id) === 'travel' ? '' : ' · ' + amountLabel(draft)} · v${draft.version}`,
    status,
    tone: status === '本地已受理'
      ? 'success'
      : status === '待回执' || status === '待完善' || issues.length > 0
        ? 'warning'
        : 'neutral',
    data: {
      amountCents:
        getDraftType(id) === 'travel' ? undefined : draftTotal(draft),
      amounts: draftCurrencyTotals(draft),
      version: saved.version,
      snapshot: structuredClone(draft),
      missingCount: issues.length,
      missingItems: issues.slice(0, 2).map((issue) => issue.message),
      period: draftPeriod(draft),
      route: structuredClone(draft.legs),
      legCount: draft.legs.length,
      expenseCount: draft.expenses.length,
    },
  };
}

function periodLabel(draft: SubmissionDraft) {
  const period = draftPeriod(draft);
  return period.start
    ? period.start === period.end
      ? period.start
      : `${period.start} — ${period.end || '待补充'}`
    : '日期待补充';
}

function SubmissionStages({ stage }: { stage: 0 | 1 | 2 }) {
  return (
    <ol className="sf-stages" aria-label="办理阶段">
      {['完善单据', '核对提交', '办理结果'].map((label, index) => (
        <li
          key={label}
          className={index === stage ? 'active' : index < stage ? 'done' : ''}
          aria-current={index === stage ? 'step' : undefined}
        >
          <span>
            {index < stage ? <Icon name="check" size={12} /> : index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function DraftOverview({
  draft,
  issues,
  onEdit,
}: {
  draft: SubmissionDraft;
  issues: ValidationIssue[];
  onEdit: (issuePath?: string) => void;
}) {
  const travel = getDraftType(draft) === 'travel';
  return (
    <div className="sf-overview">
      <section className="sf-overview-sheet">
        <div className="sf-sheet-heading">
          <WorkDocumentIcon type={getDraftType(draft)} />
          <div>
            <span>{submissionLabels[getDraftType(draft)]}</span>
            <h3>{draft.title || '未命名单据'}</h3>
          </div>
          {!travel && (
            <div className="sf-sheet-amount">
              <small>报销金额</small>
              <DraftAmount draft={draft} />
            </div>
          )}
        </div>
        <div className="sf-identity-grid">
          <div>
            <span>申请人</span>
            <strong>{draft.applicant || '待补充'}</strong>
          </div>
          <div>
            <span>部门</span>
            <strong>{draft.department || '待补充'}</strong>
          </div>
          <div>
            <span>付款公司</span>
            <strong>{draft.paymentCompany || '待补充'}</strong>
          </div>
        </div>
        <div className="sf-overview-purpose">
          <span>{travel ? '出差事由' : '报销事由'}</span>
          <p>{draft.purpose || '待补充'}</p>
        </div>
        <div className="sf-overview-section">
          <div className="sf-overview-heading">
            <h4>{travel ? '出差行程' : '费用明细'}</h4>
            <span>
              {travel
                ? `${draft.legs.length} 段行程`
                : `${draft.expenses.length} 笔费用`}
            </span>
          </div>
          {travel ? (
            draft.legs.length ? (
              <ol className="sf-route-list">
                {draft.legs.map((leg, index) => (
                  <li key={leg.id}>
                    <span className="sf-route-index">{index + 1}</span>
                    <div>
                      <strong>
                        {leg.departureCity || '出发地待补充'}
                        <Icon name="arrow" size={16} />
                        {leg.arrivalCity || '目的地待补充'}
                      </strong>
                      <small>
                        {leg.departureDate || '日期待补充'}
                        <span>—</span>
                        {leg.arrivalDate || '日期待补充'}
                      </small>
                    </div>
                    <span className="sf-route-transport">
                      {leg.transport || '交通待补充'}
                      {activeSubmissionDefaults(draft).some(
                        (entry) => entry.path === `legs.${leg.id}.transport`,
                      ) && <small>建议值</small>}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="sf-overview-empty">尚未填写行程</p>
            )
          ) : draft.expenses.length ? (
            <div className="sf-overview-expenses">
              {draft.expenses.map((expense, index) => {
                const definition = getExpenseCategory(expense.categoryId);
                const amount = parseCents(expense.amount);
                const issueCount = issues.filter((issue) =>
                  issue.path.startsWith(`expenses.${index}.`),
                ).length;
                return (
                  <div className="sf-overview-expense" key={expense.id}>
                    <span className="sf-expense-symbol">
                      <Icon
                        name={
                          definition?.template === 'T03' ||
                          definition?.template === 'T09'
                            ? 'home'
                            : 'file'
                        }
                        size={17}
                      />
                    </span>
                    <div>
                      <strong>
                        {expense.name || definition?.label || '费用类型待补充'}
                      </strong>
                      <small>
                        {[
                          definition?.label,
                          expense.checkIn ||
                            expense.departureDate ||
                            expense.date,
                          expense.city || expense.arrivalCity,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '费用信息待补充'}
                      </small>
                      {issueCount > 0 && (
                        <button
                          className="sf-overview-fix"
                          onClick={() => onEdit(`expenses.${index}`)}
                        >
                          {issueCount} 项待完善
                          <Icon name="chevron" size={11} />
                        </button>
                      )}
                    </div>
                    <strong className="sf-overview-expense-amount">
                      {amount === null ? (
                        '金额待补充'
                      ) : expense.currency === 'CNY' ? (
                        <Money value={amount} />
                      ) : (
                        `${expense.currency} ${(amount / 100).toFixed(2)}`
                      )}
                    </strong>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="sf-overview-empty">尚未添加费用</p>
          )}
        </div>
        <div className="sf-overview-meta">
          <span>
            <Icon name="tasks" size={14} />
            {periodLabel(draft)}
          </span>
          {travel ? (
            <span>
              {draft.travelType || '差旅类型待补充'} · 同行{' '}
              {draft.companions.length} 人
            </span>
          ) : (
            <span>
              <Icon name="attach" size={14} />
              {draft.files.length +
                draft.expenses.reduce(
                  (count, expense) =>
                    count + expense.files.length + expense.attachments.length,
                  0,
                )}{' '}
              份材料
            </span>
          )}
        </div>
        {getDraftType(draft) === 'expense' && (
          <div className="sf-overview-link">
            <span>关联差旅申请</span>
            <strong>{draft.applicationId || '待补充'}</strong>
          </div>
        )}
        {draft.activities.length > 0 && (
          <div className="sf-overview-link">
            <span>关联活动</span>
            <strong>
              {draft.activities
                .map(
                  (activity) =>
                    activity.activityNumber || activity.oaNumber || '待补充',
                )
                .join('、')}
            </strong>
          </div>
        )}
      </section>
      <SubmissionDefaults draft={draft} />
      {issues.length > 0 && (
        <div className="sf-completion-notice">
          <Icon name="alert" size={17} />
          <div>
            <strong>{issues.length} 项信息待完善</strong>
            {issues.slice(0, 2).map((issue) => (
              <p key={issue.path + issue.message}>{issue.message}</p>
            ))}
          </div>
          <Button onClick={() => onEdit(issues[0]?.path)}>
            补充信息
            <Icon name="arrow" size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}

function CheckResults({
  check,
  current,
  compact = false,
}: {
  check?: SubmissionCheck;
  current: boolean;
  compact?: boolean;
}) {
  if (!check)
    return (
      <div className="rs-neutral-row">
        <Icon name="shield" size={16} />
        尚未执行提交检查
      </div>
    );
  if (!current)
    return (
      <div className="rs-notice warning" role="status">
        单据或适用规则已变更，请保存后重新检查。
      </div>
    );
  return (
    <div className="sf-check-results">
      {check.issues.map((issue) => (
        <p className="rs-error" key={issue.path + issue.message}>
          <Icon name="alert" size={14} />
          {issue.message}
        </p>
      ))}
      {check.review.findings.map((finding) => (
        <div className="sf-check-finding" key={finding.rule.id}>
          <div>
            <strong>{finding.rule.name}</strong>
            <Badge tone="warning">
              {finding.state === 'unknown'
                ? '待核实'
                : finding.rule.effect === 'block'
                  ? '需处理'
                  : '提醒'}
            </Badge>
          </div>
          <p>{finding.detail}</p>
          {finding.evidence?.length ? (
            <details className="rs-source">
              <summary>{compact ? '查看依据' : '执行证据'}</summary>
              {finding.evidence.map((e, index) => (
                <p key={e.path + index}>
                  {!compact && (
                    <>
                      <code>{e.path}</code> ·{' '}
                    </>
                  )}
                  {e.quote}
                </p>
              ))}
            </details>
          ) : finding.rule.metric === 'semantic' ? (
            <small>暂无可引用的原文证据</small>
          ) : null}
          <small>{finding.actual}</small>
        </div>
      ))}
      {!compact && <RuleEvaluationResults review={check.review} />}
      {!compact && !hasBlockingIssues(check) && (
        <div className="rs-clear">
          <Icon name="check" size={16} />
          {check.review.findings.some((f) => f.state === 'unknown')
            ? '基础检查已通过，提醒项待核实'
            : check.review.findings.length
              ? '基础检查已通过，请核对提醒项'
              : '本次填写及适用规则检查已通过'}
        </div>
      )}
      <div className="rs-check-meta">
        <span>
          {compact ? '检查时间 ' : ''}
          {businessTime(check.checkedAt)}
        </span>
        {!compact && check.review.engine && (
          <span>
            {check.review.engine}
            {check.review.model ? ` · ${check.review.model}` : ''}
          </span>
        )}
        {!compact && (
          <span>
            草稿 v{check.version} · {check.review.applicable.length} 项规则
          </span>
        )}
      </div>
    </div>
  );
}

function ExpenseCheckDetails({
  check,
  current,
  receipt = false,
}: {
  check: SubmissionCheck;
  current: boolean;
  receipt?: boolean;
}) {
  const count = check.issues.length + check.review.findings.length;
  const status = !current
    ? '需重新检查'
    : count
      ? `${count} 项需核对`
      : '已通过';
  return (
    <details
      className="sf-expense-check"
      open={current && count > 0 && !receipt}
    >
      <summary>
        {receipt ? '提交时检查' : '提交检查'} · {status}
      </summary>
      <CheckResults check={check} current={current} compact />
    </details>
  );
}

export function SubmissionPage() {
  const workspace = useWorkspace();
  const [state] = useSubmissionData();
  const [tab, setTab] = useState<'drafts' | 'requests'>('drafts');
  const [creating, setCreating] = useState(false);
  async function createFromReceipts(type: string) {
    if (creating || (type !== 'personal' && type !== 'expense')) return;
    setCreating(true);
    try {
      await workspace.flush();
      const { draft } = await api<{ draft: SubmissionDraft }>('/business/new-draft', { id: type });
      await workspace.refresh();
      workspace.openPanel({ kind: 'materials', title: '发票转费用', data: { draftId: draft.id } });
    } catch (error) {
      workspace.notify(error instanceof Error ? error.message : '新建报销单失败，请重试。');
    } finally {
      setCreating(false);
    }
  }
  const activeDrafts = Object.values(state.drafts)
    .filter((draft) => draft.status === 'draft')
    .reverse();
  return (
    <div className="rs-page sf-page">
      <div className="sf-entry-grid">
        {draftIds.map((id) => (
          <button
            className="sf-entry"
            key={id}
            onClick={() => workspace.openPanel(submissionPanel(id))}
          >
            <WorkDocumentIcon type={getDraftType(id)} />
            <strong>{submissionLabels[getDraftType(id)]}</strong>
            <Icon name="arrow" size={17} />
          </button>
        ))}
      </div>
      <div className="toolbar sf-toolbar">
        <div className="tabs">
          <button
            className={tab === 'drafts' ? 'active' : ''}
            onClick={() => setTab('drafts')}
          >
            未提交草稿 <small>{activeDrafts.length}</small>
          </button>
          <button
            className={tab === 'requests' ? 'active' : ''}
            onClick={() => setTab('requests')}
          >
            提交记录 <small>{state.requests.length}</small>
          </button>
        </div>
        <label className="sf-create-reimbursement">
          <Icon name="upload" size={15} />
          <select aria-label="从票据新建报销单" value="" disabled={creating}
            onChange={(event) => void createFromReceipts(event.target.value)}>
            <option value="" disabled>{creating ? '正在新建…' : '从票据新建报销单'}</option>
            <option value="personal">新建个人费用报销</option>
            <option value="expense">新建差旅报销</option>
          </select>
        </label>
      </div>
      {tab === 'drafts' ? (
        <div className="sf-draft-cards">
          {activeDrafts.map((saved) => {
            const id = saved.id;
            const draft = state.edits[id] ?? saved;
            const summary = getSubmissionSummary(workspace.state.data, id);
            const missingCount = Number(summary.data?.missingCount ?? 0);
            return (
              <article key={id} className="sf-draft-card">
                <div className="sf-card-heading">
                  <span>
                    <WorkDocumentIcon type={getDraftType(draft)} size="compact" />
                    {submissionLabels[getDraftType(id)]}
                    <small>v{saved.version}</small>
                  </span>
                  <Badge tone={summary.tone}>{summary.status}</Badge>
                </div>
                <button
                  className="sf-card-title"
                  onClick={() => workspace.openPanel(submissionPanel(id))}
                >
                  {draft.title || submissionLabels[getDraftType(id)]}
                </button>
                {getDraftType(id) === 'travel' ? (
                  <div className="sf-card-route">
                    {draft.legs.length ? (
                      draft.legs.map((leg) => (
                        <span key={leg.id}>
                          {leg.departureCity || '待补充'}
                          <Icon name="arrow" size={14} />
                          {leg.arrivalCity || '待补充'}
                        </span>
                      ))
                    ) : (
                      <span>行程待补充</span>
                    )}
                  </div>
                ) : (
                  <div className="sf-card-amount">
                    <DraftAmount draft={draft} />
                    <small>{draft.expenses.length} 笔费用</small>
                  </div>
                )}
                <div className="sf-card-details">
                  <span>
                    {draft.documentNumber && <>{draft.documentNumber} · </>}{draft.applicant || '申请人待补充'} ·{' '}
                    {draft.department || '部门待补充'}
                  </span>
                  <span>{periodLabel(draft)}</span>
                </div>
                <div className="sf-card-footer">
                  <small>
                    {saved.status === 'awaiting_receipt'
                      ? state.requests.some(
                          (request) =>
                            request.draftId === id && request.localStatus,
                        )
                        ? '本地业务单号已生成'
                        : '等待业务系统回执'
                      : missingCount
                        ? `${missingCount} 项待完善`
                        : '填写信息完整'}
                  </small>
                  <Button
                    variant="ghost"
                    onClick={() => workspace.openPanel(submissionPanel(id))}
                  >
                    {saved.status === 'draft' ? '继续办理' : '查看回执'}
                    <Icon name="arrow" size={14} />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : state.requests.length ? (
        <div className="rs-compact-list">
          {state.requests.map((request) => (
            <button
              key={request.id}
              onClick={() =>
                workspace.openPanel(
                  submissionPanel(request.draftId, { requestId: request.id }),
                )
              }
            >
              <WorkDocumentIcon type={getDraftType(request.snapshot)} size="compact" />
              <span>
                <strong>{request.title}</strong>
                <small>
                  {request.applicant} · {request.id} ·{' '}
                  {businessTime(request.createdAt)}
                </small>
              </span>
              {getDraftType(request.snapshot) !== 'travel' && (
                <DraftAmount draft={request.snapshot} />
              )}
              <Badge tone={request.localStatus ? 'success' : 'warning'}>
                {request.localStatus ? '本地已受理' : '待回执'}
              </Badge>
              <Icon name="chevron" size={15} />
            </button>
          ))}
        </div>
      ) : (
        <Empty title="暂无提交记录" />
      )}
    </div>
  );
}

export function SubmissionPanel({ panel }: { panel: PanelSpec }) {
  const workspace = useWorkspace();
  const id = resolveDraftId(panel.id);
  if (!readSubmissionState(workspace.state.data).drafts[id])
    return <Empty title="单据不存在">请从我的单据重新选择。</Empty>;
  return <ExistingSubmissionPanel key={id} panel={panel} />;
}

function ExistingSubmissionPanel({ panel }: { panel: PanelSpec }) {
  const workspace = useWorkspace();
  const [state, setState] = useSubmissionData();
  const id = resolveDraftId(panel.id);
  const saved = state.drafts[id]!;
  const draft = state.edits[id] ?? saved;
  const expenseForm = getDraftType(saved) !== 'travel';
  const panelClass = expenseForm
    ? 'rs-panel sf-panel sf-expense-panel'
    : 'rs-panel sf-panel';
  const ruleState = (workspace.state.data[RULES_SUBMISSION_KEY] ??
    INITIAL_RULES_SUBMISSION) as RulesSubmissionState;
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempt = useSubmissionAttempt(id);
  const [retryKey, setRetryKey] = useState('');
  const submissionOperation = useRef(false);
  const panelMounted = useRef(false);
  const currentTaskId = useRef(workspace.state.activeTask);
  currentTaskId.current = workspace.state.activeTask;
  useEffect(() => {
    panelMounted.current = true;
    return () => { panelMounted.current = false; };
  }, []);
  const editingExpense = !!workspace.state.data.submissionExpenseEditors?.[id];
  const [view, setView] = useState<'overview' | 'edit'>(() =>
    editingExpense ||
    panel.data?.view === 'edit' ||
    (!draft.purpose.trim() && !draft.legs.length && !draft.expenses.length)
      ? 'edit'
      : 'overview',
  );
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [showValidation, setShowValidation] = useState(false);
  const issues = validateDraft(draft, { submit: true });
  const dirty = isDirty(draft, saved);
  const check = state.checks[id];
  const current = isCheckCurrent(saved, check, ruleState.rules);
  const canSubmit =
    !dirty &&
    !editingExpense &&
    current &&
    !hasBlockingIssues(check) &&
    saved.status === 'draft';
  const incoming = workspace.state.data.expenseDraft as
    MaterialExpenseImport | undefined;
  const batchKey = incoming
    ? `${incoming.id ?? incoming.materialBatchId ?? 'materials'}:${incoming.revision}`
    : '';
  const importTargets = incoming
    ? affectedMaterialDrafts(state.drafts, incoming)
    : [];
  const pendingImport =
    getDraftType(id) !== 'travel' &&
    incoming &&
    panel.data?.materialBatchId === incoming.materialBatchId &&
    importTargets.includes(id) &&
    importTargets.some(
      (key) => state.drafts[key]?.sourceImportKey !== batchKey,
    );
  const hasImportEdits = importTargets.some(
    (key) => state.edits[key] && isDirty(state.edits[key]!, state.drafts[key]!),
  );
  const importEditingId = importTargets.find(
    (key) => !!workspace.state.data.submissionExpenseEditors?.[key],
  );
  const importBlocked = importTargets.some(
    (key) => state.drafts[key]?.status !== 'draft',
  );

  useEffect(() => {
    setError('');
    setConfirmed(false);
    setShowValidation(false);
    setView(
      editingExpense ||
        panel.data?.view === 'edit' ||
        (!draft.purpose.trim() && !draft.legs.length && !draft.expenses.length)
        ? 'edit'
        : 'overview',
    );
  }, [id, panel.data?.step, panel.data?.requestId, panel.data?.view]);

  useEffect(() => {
    setConfirmed(false);
  }, [
    saved.version,
    dirty,
    check?.signature,
    checkSignature(saved, ruleState.rules),
  ]);

  const editDraft = (issuePath?: string) => {
    if (editingExpense) return;
    setView('edit');
    setShowValidation(true);
    requestAnimationFrame(() => {
      const fields = fieldsRef.current;
      if (!fields) return;
      const expenseIndex = /^(?:expenses)\.(\d+)/.exec(issuePath ?? '');
      const expenseButton = expenseIndex
        ? fields.querySelectorAll<HTMLButtonElement>('.sf-expense-open')[
            Number(expenseIndex[1])
          ]
        : undefined;
      if (expenseButton) {
        expenseButton.click();
        expenseButton.scrollIntoView({ block: 'center', behavior: 'instant' });
        return;
      }
      const invalid = fields.querySelector<HTMLElement>(
        '.sf-field:has(.sf-field-error) input:not([readonly]), .sf-field:has(.sf-field-error) select, .sf-field:has(.sf-field-error) textarea',
      );
      const target =
        (issuePath === 'expenses'
          ? fields.querySelector<HTMLButtonElement>('[data-add-expense]')
          : null) ??
        invalid ??
        fields.querySelector<HTMLElement>(
          'input:not([readonly]), select, textarea',
        );
      for (
        let parent = target?.parentElement;
        parent && parent !== fields;
        parent = parent.parentElement
      )
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      (target ?? fields).scrollIntoView({
        block: 'center',
        behavior: 'instant',
      });
      target?.focus({ preventScroll: true });
    });
  };

  const loadMaterials = () => {
    if (!incoming || importBlocked || importEditingId) return;
    setState((previous) => applyMaterialBatch(previous, incoming));
    setError('');
    setConfirmed(false);
    workspace.notify('费用用途、业务关联和原件已载入对应报销草稿');
  };

  useEffect(() => {
    if (pendingImport && !hasImportEdits && !importBlocked && !importEditingId)
      loadMaterials();
  }, [batchKey, pendingImport, importEditingId]);

  const change = (next: SubmissionDraft) => {
    if (saved.status !== 'draft') return;
    setState((previous) => {
      const checks = { ...previous.checks };
      delete checks[id];
      return { ...previous, edits: { ...previous.edits, [id]: next }, checks };
    });
    setError('');
    setConfirmed(false);
  };

  const draftToSave = (): SubmissionDraft | null => {
    if (editingExpense || saved.status !== 'draft') return null;
    const invalid = validateDraft(draft, { submit: false });
    if (invalid.length) {
      setError(invalid[0]!.message);
      editDraft(invalid[0]?.path);
      return null;
    }
    if (!dirty) return { ...saved, savedAt: saved.savedAt ?? stamp() };
    const invoiceFiles = (value: SubmissionDraft) =>
      value.expenses.map((item) => [
        item.id,
        item.files.map((file) => file.id),
      ]);
    const invoiceChanged =
      JSON.stringify(invoiceFiles(draft)) !==
      JSON.stringify(invoiceFiles(saved));
    return {
      ...draft,
      version: saved.version + 1,
      savedAt: stamp(),
      ...(invoiceChanged ? { invoiceUnique: undefined } : {}),
    };
  };

  const save = async () => {
    const next = draftToSave();
    if (!next) return;
    setState((previous) => {
      const edits = { ...previous.edits };
      delete edits[id];
      const checks = { ...previous.checks };
      if (dirty) delete checks[id];
      return {
        ...previous,
        drafts: { ...previous.drafts, [id]: next },
        edits,
        checks,
      };
    });
    setError('');
    setConfirmed(false);
    try {
      await workspace.flush();
      workspace.notify('草稿已保存');
    } catch (error) {
      setError(error instanceof Error ? error.message : '草稿保存失败');
    }
  };

  const saveAndCheck = async (continueToConfirm: boolean) => {
    const nextDraft = draftToSave();
    if (!nextDraft || busy) return;
    setBusy(true);
    setError('');
    setConfirmed(false);
    setState((previous) => {
      const edits = { ...previous.edits };
      delete edits[id];
      const checks = { ...previous.checks };
      delete checks[id];
      return {
        ...previous,
        drafts: { ...previous.drafts, [id]: nextDraft },
        edits,
        checks,
      };
    });
    try {
      await workspace.flush();
      const result = await api<{ check: SubmissionCheck; canSubmit: boolean }>(
        '/business/validate',
        { id },
      );
      await workspace.refresh();
      if (!result.canSubmit) {
        if (result.check.issues.length) editDraft(result.check.issues[0]?.path);
        else if (expenseForm) {
          requestAnimationFrame(() => {
            const summary =
              fieldsRef.current?.parentElement?.querySelector<HTMLElement>(
                '.sf-expense-check > summary',
              );
            summary?.scrollIntoView({ block: 'center' });
            summary?.focus({ preventScroll: true });
          });
        }
        workspace.notify('请处理待完善项');
      } else if (continueToConfirm)
        workspace.openPanel(submissionPanel(id, { step: 'confirm' }));
      else workspace.notify('检查完成');
    } catch (error) {
      setError(error instanceof Error ? error.message : '检查失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  type AcceptedSubmission = {
    request: SubmissionRequest;
    receipt: { status: string; businessId: string };
  };
  const request =
    state.requests.find((item) => item.id === panel.data?.requestId) ??
    state.requests.find((item) => item.draftId === id);
  const recordedVersion =
    request?.localStatus === 'accepted' ? request.snapshot.version : undefined;
  useEffect(() => {
    if (attempt && recordedVersion === attempt.version)
      clearSubmissionAttempt(id, attempt);
  }, [id, attempt?.key, recordedVersion]);

  const showReceipt = async (
    original: SubmissionAttempt,
    result: AcceptedSubmission,
    announce: boolean,
  ) => {
    recordSubmissionReceipt(id, original, {
      requestId: result.request.id,
      businessId: result.receipt.businessId,
    });
    // Keep the known receipt across reloads if synchronizing the workspace fails.
    await workspace.refresh();
    clearSubmissionAttempt(id, original);
    if (
      !panelMounted.current ||
      currentTaskId.current !== workspace.state.activeTask
    )
      return;
    workspace.openPanel(submissionPanel(id, { requestId: result.request.id }));
    if (announce) {
      workspace.setTaskStatus('本地已受理');
      workspace.message(
        `本地业务服务已受理，单号 ${result.receipt.businessId}。`,
        [
          {
            kind: 'submission',
            id,
            title: saved.title,
            status: '本地已受理',
            tone: 'success',
            data: { requestId: result.request.id, receipt: result.receipt },
          },
        ],
      );
    }
  };

  const submit = async (retry?: SubmissionAttempt) => {
    if (submissionOperation.current || busy) return;
    if (retry ? retryKey !== retry.key : !canSubmit || !confirmed || attempt) {
      setError('请核对当前单据及检查结果。');
      return;
    }
    submissionOperation.current = true;
    setBusy(true);
    setError('');
    setRetryKey('');
    try {
      await workspace.flush();
      const original = retry ?? beginSubmissionAttempt(id, saved.version);
      let result: AcceptedSubmission;
      try {
        result = await api<AcceptedSubmission>('/business/submit', {
          id,
          version: original.version,
          idempotencyKey: original.key,
        });
      } catch (error) {
        if (submitWasRejected(error)) {
          clearSubmissionAttempt(id, original);
          setConfirmed(false);
          await workspace.refresh().catch(() => undefined);
        }
        throw error;
      }
      await showReceipt(original, result, true);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : '未取得提交结果，请查询原请求。',
      );
    } finally {
      submissionOperation.current = false;
      setBusy(false);
    }
  };

  const lookupReceipt = async (original: SubmissionAttempt) => {
    if (submissionOperation.current) return;
    submissionOperation.current = true;
    setBusy(true);
    setError('');
    setRetryKey('');
    try {
      const params = new URLSearchParams({
        id,
        version: String(original.version),
        idempotencyKey: original.key,
      });
      const result = await api<
        | ({ status: 'accepted' } & AcceptedSubmission)
        | { status: 'unrecorded'; canRetry: boolean }
      >('/business/submission-receipt?' + params);
      if (result.status === 'accepted') {
        await showReceipt(original, result, false);
      } else if (result.canRetry && !original.receipt) {
        setRetryKey(original.key);
      } else {
        await workspace.refresh();
        clearSubmissionAttempt(id, original);
        setConfirmed(false);
        setError('未查到此请求的回执，草稿状态已更新，请重新核对。');
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : '回执查询失败，请重试。',
      );
    } finally {
      submissionOperation.current = false;
      setBusy(false);
    }
  };

  if (attempt && !request?.localStatus) {
    return (
      <div className={panelClass}>
        <div className="rs-receipt-state">
          <span>
            <Icon name={attempt.receipt ? 'check' : 'clock'} size={26} />
          </span>
          <div>
            <h3>{attempt.receipt ? '本地已受理' : '提交结果待核实'}</h3>
          </div>
        </div>
        <dl className="rs-definition">
          <dt>单据事由</dt>
          <dd>{saved.purpose}</dd>
          <dt>提交版本</dt>
          <dd>v{attempt.version}</dd>
          {attempt.receipt && (
            <>
              <dt>业务单号</dt>
              <dd>{attempt.receipt.businessId}</dd>
            </>
          )}
        </dl>
        <p role="status">
          {attempt.receipt
            ? '已取得本地受理回执。'
            : retryKey === attempt.key
              ? '暂未查到受理记录，可使用原请求重新提交。'
              : '请查询原提交请求，确认是否已受理。'}
        </p>
        {error && (
          <p className="rs-error" role="alert">
            {error}
          </p>
        )}
        <div className="rs-panel-actions">
          <Button
            variant="primary"
            icon="refresh"
            disabled={busy}
            onClick={() => void lookupReceipt(attempt)}
          >
            查询原请求回执
          </Button>
          {retryKey === attempt.key && (
            <Button disabled={busy} onClick={() => void submit(attempt)}>
              使用原请求重试
            </Button>
          )}
        </div>
      </div>
    );
  }
  if (saved.status === 'awaiting_receipt' || panel.data?.requestId) {
    const snapshot = request?.snapshot ?? saved;
    const receiptDetails = (
      <>
        <dt>单据类型</dt>
        <dd>{submissionLabels[getDraftType(id)]}</dd>
        <dt>申请人</dt>
        <dd>{request?.applicant || snapshot.applicant}</dd>
        <dt>部门</dt>
        <dd>{snapshot.department}</dd>
        <dt>付款公司</dt>
        <dd>{snapshot.paymentCompany}</dd>
        <dt>请求编号</dt>
        <dd>{request?.id || '待返回'}</dd>
      </>
    );
    return (
      <div className={panelClass}>
        {!expenseForm && <SubmissionStages stage={2} />}
        <div className="rs-receipt-state">
          <span>
            <Icon name="clock" size={26} />
          </span>
          <div>
            <h3>{request?.localStatus ? '本地业务已受理' : '等待业务回执'}</h3>
            {!expenseForm && (
              <Badge tone={request?.localStatus ? 'success' : 'warning'}>
                {request?.localStatus ? '已受理' : '待核实'}
              </Badge>
            )}
          </div>
        </div>
        <dl className="rs-definition">
          {!expenseForm && receiptDetails}
          {expenseForm && (
            <>
              <dt>报销金额</dt>
              <dd>
                <DraftAmount draft={snapshot} />
              </dd>
            </>
          )}
          <dt>单据事由</dt>
          <dd>{snapshot.purpose}</dd>
          <dt>记录时间</dt>
          <dd>{businessTime(request?.createdAt || snapshot.savedAt)}</dd>
          <dt>业务单号</dt>
          <dd>{request?.businessId || '待业务系统返回'}</dd>
          <dt>受理结果</dt>
          <dd>
            {request?.localStatus
              ? '本地模拟业务服务已受理；未提交至外部审批系统'
              : '待业务系统确认'}
          </dd>
          {request?.receiptCheckedAt && (
            <>
              <dt>最近查询</dt>
              <dd>{request.receiptCheckedAt}</dd>
            </>
          )}
        </dl>
        {expenseForm && (
          <details className="sf-expense-check">
            <summary>单据信息</summary>
            <dl className="rs-definition rs-compact-definition">
              {receiptDetails}
            </dl>
          </details>
        )}
        {error && (
          <p className="rs-error" role="alert">
            {error}
          </p>
        )}
        {request?.check &&
          (expenseForm ? (
            <ExpenseCheckDetails check={request.check} current receipt />
          ) : (
            <Section title="提交时检查">
              <CheckResults check={request.check} current />
            </Section>
          ))}
        <div className="rs-panel-actions">
          <Button
            icon="link"
            onClick={() => {
              workspace.attach({
                kind: 'submission',
                id,
                title: snapshot.title,
              });
              workspace.closePanel();
              workspace.navigate('chat');
            }}
          >
            加入对话
          </Button>
          <Button
            variant="primary"
            icon="refresh"
            disabled={busy}
            onClick={async () => {
              if (!request || busy) return;
              setBusy(true);
              setError('');
              try {
                await workspace.flush();
                const result = await api<{
                  receipt: { status: string; businessId?: string };
                }>(
                  `/receipts/${encodeURIComponent(request.receiptId || request.id)}`,
                );
                await workspace.refresh();
                workspace.notify(
                  result.receipt.status === 'accepted'
                    ? `本地已受理：${result.receipt.businessId}`
                    : '回执状态已更新',
                );
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : '回执查询失败',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            查询回执
          </Button>
          {saved.status === 'awaiting_receipt' && request?.localStatus && (
            <Button
              disabled={busy}
              icon="plus"
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await workspace.flush();
                  const result = await api<{ draft: SubmissionDraft }>(
                    '/business/new-draft',
                    { id },
                  );
                  await workspace.refresh();
                  workspace.openPanel(
                    submissionPanel(result.draft.id, { view: 'edit' }),
                  );
                  workspace.notify('已新建同类草稿，原回执已保留');
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : '新建草稿失败',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              新建同类单据
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (panel.data?.step === 'confirm') {
    const period = draftPeriod(saved);
    return (
      <div className={panelClass}>
        {!expenseForm && <SubmissionStages stage={1} />}
        <div className="rs-confirm-amount">
          <span>{submissionLabels[getDraftType(id)]}</span>
          {getDraftType(id) !== 'travel' && <DraftAmount draft={saved} />}
        </div>
        <dl className="rs-definition">
          <dt>申请人</dt>
          <dd>{saved.applicant}</dd>
          <dt>部门</dt>
          <dd>{saved.department}</dd>
          <dt>付款公司</dt>
          <dd>{saved.paymentCompany}</dd>
          <dt>事由</dt>
          <dd>{saved.purpose}</dd>
          <dt>业务日期</dt>
          <dd>
            {expenseForm
              ? periodLabel(saved)
              : `${period.start} — ${period.end}`}
          </dd>
          {getDraftType(id) === 'travel' && (
            <>
              <dt>行程</dt>
              <dd>
                {saved.legs
                  .map((leg) => `${leg.departureCity} → ${leg.arrivalCity}`)
                  .join('，')}
              </dd>
              <dt>同行人</dt>
              <dd>{saved.companions.join('、') || '无'}</dd>
            </>
          )}
          {getDraftType(id) !== 'travel' && (
            <>
              <dt>费用笔数</dt>
              <dd>{saved.expenses.length} 笔</dd>
            </>
          )}
          {!expenseForm && (
            <>
              <dt>检查版本</dt>
              <dd>
                草稿 v{saved.version} · {businessTime(check?.checkedAt)}
              </dd>
            </>
          )}
        </dl>
        {expenseForm &&
          current &&
          !dirty &&
          check &&
          check.review.findings.length > 0 && (
            <ExpenseCheckDetails check={check} current />
          )}
        {(!current || dirty) && (
          <div className="rs-notice warning">
            单据或适用规则已变更，请返回重新检查。
          </div>
        )}
        <label className="rs-check-label">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我已核对内容，确认提交请求。
        </label>
        {error && (
          <p className="rs-error" role="alert">
            {error}
          </p>
        )}
        <div className="rs-panel-actions">
          <Button onClick={() => workspace.openPanel(submissionPanel(id))}>
            返回草稿
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || !confirmed || busy}
            onClick={() => void submit()}
          >
            确认提交
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={panelClass}>
      {!expenseForm && <SubmissionStages stage={0} />}
      {pendingImport && !editingExpense ? (
        <div className="rs-import-notice">
          <div>
            <strong>{incoming!.items.length} 笔费用待载入</strong>
            <small>
              {importBlocked
                ? '当前报销单有待回执请求，请先核实办理结果。'
                : importEditingId
                  ? `${submissionLabels[getDraftType(importEditingId)]}有未确认的费用编辑，请先保存或取消。`
                  : '载入将更新本批次费用，并保留当前填写内容。'}
            </small>
          </div>
          {importEditingId && importEditingId !== id && (
            <Button
              onClick={() =>
                workspace.openPanel(
                  submissionPanel(importEditingId, { view: 'edit' }),
                )
              }
            >
              继续费用编辑
            </Button>
          )}
          <Button
            disabled={importBlocked || !!importEditingId}
            onClick={loadMaterials}
          >
            载入费用
          </Button>
        </div>
      ) : null}
      {!expenseForm && (
        <div className="sf-view-toolbar">
          <div className="sf-view-tabs" role="tablist" aria-label="单据视图">
            <button
              type="button"
              role="tab"
              id={`overview-tab-${id}`}
              aria-selected={view === 'overview'}
              aria-controls={`overview-${id}`}
              disabled={editingExpense || busy}
              className={view === 'overview' ? 'active' : ''}
              onClick={() => setView('overview')}
            >
              单据概览
            </button>
            <button
              type="button"
              role="tab"
              id={`edit-tab-${id}`}
              aria-selected={view === 'edit'}
              aria-controls={`edit-${id}`}
              className={view === 'edit' ? 'active' : ''}
              onClick={() => setView('edit')}
            >
              编辑单据
            </button>
          </div>
          <Badge tone={dirty ? 'warning' : 'neutral'}>
            {dirty ? '有未保存更改' : `草稿 v${saved.version}`}
          </Badge>
        </div>
      )}
      {!expenseForm && view === 'overview' ? (
        <div
          role="tabpanel"
          id={`overview-${id}`}
          aria-labelledby={`overview-tab-${id}`}
        >
          <DraftOverview draft={draft} issues={issues} onEdit={editDraft} />
        </div>
      ) : (
        <div
          className="sf-edit-content"
          ref={fieldsRef}
          role={expenseForm ? undefined : 'tabpanel'}
          id={`edit-${id}`}
          aria-labelledby={expenseForm ? undefined : `edit-tab-${id}`}
        >
          <SubmissionFields
            key={id}
            draft={draft}
            onChange={change}
            issues={
              current && !dirty ? check?.issues : showValidation ? issues : []
            }
            expenseAction={
              expenseForm && (
                <Button
                  icon="upload"
                  variant="ghost"
                  disabled={editingExpense || busy}
                  onClick={() =>
                    workspace.openPanel({
                      kind: 'materials',
                      title: 'AI 发票转费用',
                      data: { draftId: id },
                    })
                  }
                >
                  AI 发票转费用
                </Button>
              )
            }
          />
        </div>
      )}
      {check &&
        !editingExpense &&
        (expenseForm ? (
          <ExpenseCheckDetails check={check} current={current && !dirty} />
        ) : (
          <Section
            title="提交检查"
            action={
              <Button
                variant="ghost"
                disabled={editingExpense || busy}
                onClick={() => saveAndCheck(false)}
              >
                重新检查
              </Button>
            }
          >
            <CheckResults check={check} current={current && !dirty} />
          </Section>
        ))}
      {!editingExpense && error && (
        <p className="rs-error" role="alert">
          {error}
        </p>
      )}
      {!editingExpense && (
        <div className="rs-panel-actions sf-primary-actions">
          <Button
            variant="ghost"
            icon="link"
            disabled={editingExpense || busy}
            onClick={() => {
              workspace.attach({
                kind: 'submission',
                id,
                title: draft.title,
                version: 'v' + saved.version,
              });
              workspace.closePanel();
              workspace.navigate('chat');
            }}
          >
            加入对话
          </Button>
          <span className="rs-grow" />
          <Button disabled={editingExpense || busy} onClick={save}>
            保存草稿
          </Button>
          <Button
            variant="primary"
            disabled={editingExpense || busy}
            onClick={() =>
              canSubmit
                ? workspace.openPanel(submissionPanel(id, { step: 'confirm' }))
                : saveAndCheck(true)
            }
          >
            {expenseForm || canSubmit
              ? '核对并提交'
              : dirty
                ? '保存并检查'
                : '检查并继续'}
            <Icon name="arrow" size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}
