import {
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { flushSync } from 'react-dom';
import {
  presentDocument,
  type DocumentStep,
  type GenericDocument,
} from '../document-query/document-model';
import { Icon } from './ui';
import { formatCents } from './RulesSubmission';
import { businessTime } from './time-format';
import type { WorkDocumentContent } from './work-document-model';
import {
  expenseAmount,
  workInvoices,
  WorkInvoiceList,
  WorkInvoiceViewer,
} from './WorkInvoiceImages';
import './work-document-details.css';

export function workMeasure(doc: WorkDocumentContent) {
  if (doc.amountCents !== undefined) return formatCents(doc.amountCents);
  return doc.days !== undefined ? `${doc.days} 天` : '—';
}

function Section({
  title,
  count,
  children,
  evidence,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  evidence?: string;
}) {
  return (
    <section className="wd-section" data-evidence-section={evidence}>
      <h4>
        {title}
        {count !== undefined && <span>{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const trailStatus: Record<DocumentStep['status'], string> = {
  done: '已完成',
  current: '处理中',
  future: '待流转',
  conditional: '条件节点',
  returned: '已退回',
};

const workflowFields = new Set([
  '会签规则',
  '已通过',
  '待处理',
  '退回人',
  '退回原因',
  '审批意见',
  '预计时间',
  '支付处理',
]);

function DocumentTrail({
  document: doc,
  progress,
}: {
  document: WorkDocumentContent;
  progress?: GenericDocument;
}) {
  const active =
    progress?.status === 'needs_action' || progress?.status === 'processing';
  const current = active ? progress.current : undefined;
  const steps: DocumentStep[] =
    progress?.steps ??
    (doc.steps ?? []).map((step, index) => ({
      id: String(index),
      label: step.label,
      status: step.status,
      actors: [step.actor],
      time: step.time,
    }));
  if (!steps.length && !progress) return null;
  const activeSteps = steps.filter((step) => step.status === 'current');
  // A connector can return the active assignment without a corresponding history row.
  const trail = [...steps];
  if (current && !activeSteps.length) {
    const next = steps.findIndex(
      (step) => step.status === 'future' || step.status === 'conditional',
    );
    trail.splice(next < 0 ? trail.length : next, 0, {
      id: 'current-assignment-' + current.label,
      label: current.label,
      actors: current.actors,
      status: 'current',
      time: current.since ? businessTime(current.since) + ' 起' : undefined,
    });
  }
  const fields = (progress?.details ?? []).filter((field) =>
    workflowFields.has(field.label),
  );
  const notes = new Set(fields.map((field) => field.value.trim()));
  const extra = [...fields];
  if (
    current &&
    activeSteps.length > 0 &&
    !activeSteps.some((step) => step.label === current.label)
  ) {
    extra.push({
      label: '当前环节',
      value: current.label,
    });
  }
  if (progress?.paymentStatus && !notes.has(progress.paymentStatus))
    extra.push({ label: '付款状态', value: progress.paymentStatus });
  for (const step of steps) {
    const note = step.note?.trim();
    if (!note || notes.has(note)) continue;
    extra.push({ label: step.label, value: note });
    notes.add(note);
  }
  const estimate = progress && presentDocument(progress).estimateLabel;
  return (
    <Section title="审批流转">
      {trail.length ? (
        <ol className="wd-trail">
          {trail.map((step) => {
            const owner =
              step.status === 'current' && activeSteps.length === 1
                ? current
                : undefined;
            let actors = step.actors ?? [];
            if (owner) actors = owner.actors;
            else if (current && step.status === 'current')
              actors = actors.filter((actor) => current.actors.includes(actor));
            const actor =
              actors.join('、') ||
              (progress && step.status === 'current' ? '处理人待确认' : '');
            const state = trailStatus[step.status] ?? '状态待核实';
            const time =
              step.time ||
              (owner?.since ? businessTime(owner.since) + ' 起' : '');
            return (
              <li key={step.id} className={step.status}>
                <i />
                <div>
                  <strong>{step.label}</strong>
                  <span>
                    {actor ? actor + ' · ' : ''}
                    {state}
                  </span>
                </div>
                <time>{progress && !time ? '' : businessTime(time)}</time>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="wd-empty">来源系统暂未提供审批记录。</p>
      )}
      {!!extra.length && (
        <details className="wd-flow-notes">
          <summary>流转备注</summary>
          <dl>
            {extra.map((field, index) => (
              <Field key={index} label={field.label} value={field.value} />
            ))}
          </dl>
        </details>
      )}
      {estimate && (
        <details className="wd-flow-notes">
          <summary>{estimate}</summary>
          <p>{progress?.estimate?.basis}</p>
        </details>
      )}
    </Section>
  );
}

export interface WorkDocumentDetailsHandle {
  revealExpense: (id: string) => HTMLElement | null;
  revealInvoices: () => HTMLElement | null;
}

export function WorkDocumentDetails({
  document: doc,
  view = 'work',
  progressDocument,
  highlightedExpenseIds,
  ref,
}: {
  document: WorkDocumentContent;
  view?: 'work' | 'source' | 'progress' | 'progress-source';
  progressDocument?: GenericDocument;
  highlightedExpenseIds?: readonly string[];
  ref?: Ref<WorkDocumentDetailsHandle>;
}) {
  const work = view !== 'source';
  const progress = view === 'progress' || view === 'progress-source';
  const [tab, setTab] = useState<'expenses' | 'invoices'>('expenses');
  const [imageId, setImageId] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const tabId = useId();
  const invoiceTab = work && doc.system === 'expense';
  const invoices = invoiceTab ? workInvoices(doc) : [];
  const activeImage = invoices.find((item) => item.file.id === imageId);
  const invoiceIds = new Set(invoices.map((item) => item.file.id));
  const files = doc.files?.filter((file) => !invoiceIds.has(file.id));
  useImperativeHandle(ref, () => ({
    revealExpense(id) {
      if (!doc.expenses?.some((expense) => expense.id === id)) return null;
      if (tab !== 'expenses') flushSync(() => setTab('expenses'));
      return (
        root.current?.querySelector<HTMLElement>(
          `[data-expense-id="${CSS.escape(id)}"]`,
        ) ?? null
      );
    },
    revealInvoices() {
      if (!invoiceTab) return null;
      if (tab !== 'invoices') flushSync(() => setTab('invoices'));
      return (
        root.current?.querySelector<HTMLElement>(
          '[data-evidence-section="invoices"]',
        ) ?? null
      );
    },
  }));

  const travel =
    doc.documentType === 'travel' ||
    doc.kind === '出差申请' ||
    doc.kind === '差旅申请';
  const compactFields =
    work && view !== 'progress-source' && (travel || invoiceTab);
  const hideRequestNumber = !progress && (
    travel || doc.system === 'expense' || doc.documentType === 'personal' ||
    doc.documentType === 'expense' || doc.kind.includes('报销')
  );
  const hiddenFields = travel
    ? ['预算费用', '预计费用', '提交时间', '出差期间', '出差时长', '费用归属']
    : ['提交时间', '业务日期', '收款人', '费用归属'];
  const measureLabel =
    travel && doc.amountCents !== undefined
      ? '预计费用'
      : doc.amountCents === undefined
        ? '申请时长'
        : doc.system === 'expense'
          ? '报销金额'
          : '申请金额';
  const expenseList = (
    <ul className="wd-lines wd-expenses">
      {doc.expenses?.map((e) => {
        const linked = invoices.filter(
          (invoice) => invoice.image && invoice.expenses.includes(e),
        );
        return (
          <li
            key={e.id}
            data-expense-id={e.id}
            data-located={highlightedExpenseIds?.includes(e.id) || undefined}
          >
            <div>
              <strong>{e.name}</strong>
              <small>
                {e.categoryName} · {e.date}
                {e.nights ? ` · ${e.nights} 晚` : ''}
                {e.people ? ` · ${e.people} 人` : ''}
              </small>
              {e.reason && <p>{e.reason}</p>}
              {e.oaId && <small>关联 OA · {e.oaId}</small>}
              {linked.map((invoice) => (
                <button
                  key={invoice.file.id}
                  className="wd-linked-invoice"
                  type="button"
                  onClick={() => setImageId(invoice.file.id)}
                  aria-label={`查看${e.name}关联发票${linked.length > 1 ? '，' + invoice.file.name : ''}`}
                >
                  <Icon name="file" size={12} />
                  {linked.length > 1 ? invoice.file.name : '查看发票'}
                </button>
              ))}
            </div>
            <em>{expenseAmount(e)}</em>
          </li>
        );
      })}
    </ul>
  );
  return (
    <article className="wd-document" ref={root} aria-label="单据详情">
      <header className="wd-head">
        <h3>单据详情</h3>
        {!progress && (
          <span className="wd-stage">
            <i />
            {doc.stage}
          </span>
        )}
      </header>
      {(!work || !travel || view === 'progress-source') &&
        (!progress ||
          doc.total ||
          doc.amountCents !== undefined ||
          doc.days !== undefined) && (
          <div className="wd-total" data-evidence-section="amount">
            <span>{doc.total?.label || measureLabel}</span>
            <strong>{doc.total?.value || workMeasure(doc)}</strong>
            <span className="wd-kind">{doc.kind}</span>
          </div>
        )}
      <dl className="wd-fields">
        <Field label="申请人" value={doc.person} />
        <Field label="所属部门" value={doc.department} />
        {!hideRequestNumber && <Field label="申请单号" value={doc.id} />}
        {!compactFields && (
          <Field
            label="提交时间"
            value={doc.submittedAt && businessTime(doc.submittedAt)}
          />
        )}
        <Field label="付款公司" value={doc.paymentCompany} />
        {!compactFields && (
          <Field label={travel ? '出差期间' : '业务日期'} value={doc.period} />
        )}
        <Field label="差旅类型" value={doc.travelType} />
        {!compactFields &&
          travel &&
          doc.amountCents !== undefined &&
          doc.days !== undefined && (
            <Field label="出差时长" value={`${doc.days} 天`} />
          )}
        <Field label="关联申请单" value={doc.applicationId} />
        {doc.specificFields
          ?.filter(
            (f) =>
              !(hideRequestNumber && f.label === '申请单号') &&
              (!compactFields || !hiddenFields.includes(f.label)) &&
              !(
                progress &&
                workflowFields.has(f.label) &&
                progressDocument?.details.some(
                  (field) => field.label === f.label && field.value === f.value,
                )
              ),
          )
          .map((f) => (
            <Field key={f.label} label={f.label} value={f.value} />
          ))}
      </dl>
      {doc.purpose && (
        <div className="wd-purpose">
          <span>事由</span>
          <p>{doc.purpose}</p>
        </div>
      )}
      {invoiceTab ? (
        <section className="wd-expense-section" aria-label="费用与发票">
          <div
            className="wd-expense-tabs"
            role="tablist"
            aria-label="费用与发票"
          >
            {(['expenses', 'invoices'] as const).map((key) => (
              <button
                type="button"
                key={key}
                role="tab"
                id={tabId + '-' + key + '-tab'}
                aria-controls={tabId + '-' + key}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
                onKeyDown={(event) => {
                  if (
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'expenses'
                      : event.key === 'End'
                        ? 'invoices'
                        : key === 'expenses'
                          ? 'invoices'
                          : 'expenses';
                  setTab(next);
                  document.getElementById(tabId + '-' + next + '-tab')?.focus();
                }}
              >
                {key === 'expenses' ? '费用明细' : '发票影像'}
                {(!progress ||
                  (key === 'expenses' ? doc.expenses : doc.files)) && (
                  <span>
                    {key === 'expenses'
                      ? (doc.expenses?.length ?? 0)
                      : invoices.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          {doc.expenseSummary && (
            <p className="wd-expense-summary">{doc.expenseSummary}</p>
          )}
          <div
            role="tabpanel"
            id={tabId + '-expenses'}
            aria-labelledby={tabId + '-expenses-tab'}
            hidden={tab !== 'expenses'}
            tabIndex={0}
          >
            {doc.expenses?.length ? (
              expenseList
            ) : (
              <p className="wd-empty wd-invoice-empty">
                来源系统未提供费用明细。
              </p>
            )}
          </div>
          <div
            role="tabpanel"
            id={tabId + '-invoices'}
            aria-labelledby={tabId + '-invoices-tab'}
            hidden={tab !== 'invoices'}
            tabIndex={0}
            data-evidence-section="invoices"
          >
            {progress && !doc.files ? (
              <p className="wd-empty wd-invoice-empty">
                来源系统未提供发票影像清单。
              </p>
            ) : (
              <WorkInvoiceList
                invoices={invoices}
                onOpen={(item) => setImageId(item.file.id)}
              />
            )}
          </div>
        </section>
      ) : (
        !!doc.expenses?.length && (
          <Section title="报销费用" count={doc.expenses.length}>
            {expenseList}
          </Section>
        )
      )}
      {!!doc.legs?.length && (
        <Section title="差旅行程" count={doc.legs.length} evidence="itinerary">
          <ol className="wd-route">
            {doc.legs.map((leg, i) => (
              <li key={leg.id}>
                <span className="wd-stop">{i + 1}</span>
                <div>
                  <strong>
                    {leg.departureCity}
                    <Icon name="arrow" size={14} />
                    {leg.arrivalCity}
                  </strong>
                  <small>
                    {leg.departureDate}
                    {leg.arrivalDate && leg.arrivalDate !== leg.departureDate
                      ? ` 至 ${leg.arrivalDate}`
                      : ''}
                    <b>·</b>
                    {leg.transport}
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {!doc.legs?.length && !!doc.itineraryFields?.length && (
        <Section title="差旅行程" count={doc.itineraryFields.length}>
          <ol className="wd-route wd-route-text">
            {doc.itineraryFields.map((field, index) => (
              <li key={field.label}>
                <span className="wd-stop">{index + 1}</span>
                <div>
                  <strong>{field.label}</strong>
                  <small>{field.value}</small>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      {!!doc.activities?.length && (
        <Section title="活动 / 派工" count={doc.activities.length}>
          <ul className="wd-lines">
            {doc.activities.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.description}</strong>
                  <small>
                    {a.oaNumber} · {a.allocation}
                  </small>
                  <small>
                    {a.effectiveDate} 至 {a.expiryDate}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {(!progress || doc.files || doc.attachment !== undefined) && (
        <Section
          title={invoices.length ? '其他附件' : '附件'}
          count={files?.length}
          evidence="attachments"
        >
          {files?.length ? (
            <ul className="wd-files">
              {files.map((f) => (
                <li key={f.id}>
                  <Icon name="file" size={16} />
                  <span>
                    {f.hasLocalOriginal ? (
                      <a
                        href={
                          '/api/local/files/' +
                          encodeURIComponent(f.id) +
                          '/download'
                        }
                        download
                      >
                        {f.name}
                      </a>
                    ) : (
                      f.name
                    )}
                  </span>
                  <small>{fileSize(f.size)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="wd-empty">
              {invoices.length
                ? '暂无其他附件'
                : doc.attachment
                  ? '已关联材料，来源系统未提供文件清单。'
                  : '暂无附件'}
            </p>
          )}
        </Section>
      )}
      <DocumentTrail
        document={doc}
        progress={progress ? progressDocument : undefined}
      />
      {!progress && doc.decision?.reason && (
        <Section
          title={doc.decision.decision === 'return' ? '退回原因' : '审批意见'}
        >
          <p className="wd-decision-note">{doc.decision.reason}</p>
        </Section>
      )}
      {!progress && (
        <div className="wd-source">
          <Icon name="link" size={13} />{' '}
          {doc.sourceLabel ||
            (doc.system === 'oa' ? 'OA 办公系统' : '费用报销系统')}
          {doc.synthetic && ' · 本地样例'} · v{doc.version}
        </div>
      )}
      {activeImage && (
        <WorkInvoiceViewer
          invoices={invoices}
          active={activeImage}
          onSelect={(item) => setImageId(item.file.id)}
          onClose={() => setImageId(null)}
        />
      )}
    </article>
  );
}
