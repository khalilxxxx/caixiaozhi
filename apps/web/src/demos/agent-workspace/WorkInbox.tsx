import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace, type PanelSpec } from './workspace';
import { Button, Empty, Icon } from './ui';
import { api } from './runtime-client';
import {
  INITIAL_RULES_SUBMISSION,
  readAuditReview,
  type RulesSubmissionState,
} from './RulesSubmission';
import { summarizeWorkReview } from './work-review-model';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import { workMeasure } from './WorkDocumentDetails';
import { findWorkDocument, workDocumentTitle, type WorkDocument } from './work-document-model';
import type { WorkReview } from './WorkRuleDetails';
import { workDocumentHref } from './work-document-link';
import { ReviewLayoutBody } from '../approval-assistant/ReviewLayoutBody';
import { WorkApprovalAction } from './WorkApprovalAction';
import './work-inbox.css';

const mascot = '/agent-assets/mascot-exploration-20261117/c-review.png';
const filters = ['all', 'attention', 'unknown', 'clear'] as const;
type Filter = (typeof filters)[number];
type Status = Exclude<Filter, 'all'>;
const labels = {
  all: '全部',
  attention: '需关注',
  unknown: '待核实',
  clear: '未发现异常',
};
type WorkQueue = {
  approvals: { id: string; category: Status }[];
  unavailableSources: string[];
};
const sourceLabels: Record<string, string> = { expense: '费用报销系统', oa: 'OA办公系统' };
const outcomes = ['attention', 'unknown', 'clear'] as const;
type Item = { doc: WorkDocument; result: WorkReview; status: Status };

function stateLabel(result: WorkReview) {
  if (result.stale) return '结果待更新';
  if (!result.checked) return '待审查';
  return labels[result.review.status];
}

function WorkOverview({
  items,
  counts,
  partial,
}: {
  items: Item[];
  counts: Record<Status, number>;
  partial: boolean;
}) {
  const frequency = new Map<string, number>();
  for (const { result } of items) {
    for (const name of new Set(result.risks.map((f) => f.rule.name)))
      frequency.set(name, (frequency.get(name) ?? 0) + 1);
  }
  const risks = [...frequency].sort((a, b) => b[1] - a[1]).slice(0, 2);
  let headline = partial ? '已读取的范围内暂无待办' : '当前没有待办单据';
  if (counts.attention) headline = `${counts.attention} 张单据需优先关注`;
  else if (counts.unknown) headline = `${counts.unknown} 张单据待核实`;
  else if (items.length) headline = '当前待办未发现异常';
  const pending = items.filter((i) => !i.result.checked).length;
  const subline = risks.length
    ? risks.map(([name, count]) => `${name} ${count} 张`).join(' · ')
    : pending
      ? `${pending} 张单据尚无当前版本的审查结果`
      : counts.unknown
        ? '部分适用规则还需补充证据或完成审查'
        : '';
  return (
    <section className="wi-overview" aria-label="小智审单概览">
      <img className="wi-mascot" src={mascot} alt="" width="100" height="100" />
      <div className="wi-brief">
        <h2>小智审单概览</h2>
        <strong>{headline}</strong>
        {subline && <p>{subline}</p>}
      </div>
      <div className="wi-distribution">
        <div className="wi-chart-heading">
          <strong>待办分布</strong>
          <span>
            {partial ? '已读取' : '共'} <b>{items.length}</b> 张
          </span>
        </div>
        <div className="wi-bar" aria-hidden="true">
          {outcomes.map(
            (k) =>
              counts[k] > 0 && (
                <i className={`wi-${k}`} style={{ flex: counts[k] }} key={k} />
              ),
          )}
        </div>
        <div className="wi-legend">
          {outcomes.map((k) => (
            <span key={k}>
              <i className={`wi-dot wi-${k}`} />
              {labels[k]} <b>{counts[k]}</b>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkList({
  docs,
  state,
}: {
  docs: WorkDocument[];
  state: RulesSubmissionState;
}) {
  const w = useWorkspace();
  const [filter, setFilter] = useState<Filter>('all');
  const [retry, setRetry] = useState(0);
  const [response, setResponse] = useState<{ key: string; queue?: WorkQueue; error?: string }>();
  const key = JSON.stringify([
    docs.map((doc) => [doc.id, doc.version, doc.stage, doc.steps?.filter((step) => step.status === 'current').map((step) => step.actor)]),
    state.rules.map((rule) => [rule.id, rule.version, rule.enabled]),
    Object.entries(state.reviewResults || {}).map(([id, result]) => [id, result.documentVersion, result.checkedAt, result.signature]),
    w.state.data.documentSources?.states,
    retry,
  ]);
  useEffect(() => {
    let active = true;
    api<WorkQueue>('/business/work-inbox').then(
      (queue) => { if (active) setResponse({ key, queue }); },
      () => { if (active) setResponse({ key, error: '暂时无法读取待办单据。' }); },
    );
    return () => { active = false; };
  }, [key]);
  const current = response?.key === key ? response : undefined;
  const queue = current?.queue;
  const items = useMemo(() => {
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    return (queue?.approvals ?? []).flatMap(({ id, category }) => {
      const doc = byId.get(id);
      if (!doc) return [];
      return [{ doc, result: summarizeWorkReview(doc, readAuditReview(doc, state)), status: category }];
    });
  }, [queue, docs, state]);
  const syncAttempt = useRef('');
  const missing = queue && items.length !== queue.approvals.length;
  const syncKey = missing ? JSON.stringify([retry, queue.approvals.map(item => item.id)]) : '';
  useEffect(() => {
    if (!syncKey || syncAttempt.current === syncKey) return;
    syncAttempt.current = syncKey;
    void w.refresh().catch(() => {});
  }, [syncKey, w.refresh]);
  if (missing) return (
    <div className="wi-inbox" role="status">
      待办队列现有 {queue.approvals.length} 张，单据详情尚待同步。
      <Button variant="ghost" onClick={() => setRetry(n => n + 1)}>重新同步</Button>
    </div>
  );
  if (!queue) return (
    <div className="wi-inbox" role="status">
      {current?.error || '正在读取待办单据…'}
      {current?.error && <Button variant="ghost" onClick={() => setRetry(n => n + 1)}>重试</Button>}
    </div>
  );
  const partial = queue.unavailableSources.length > 0;
  const counts = { attention: 0, unknown: 0, clear: 0 };
  items.forEach(({ status }) => counts[status]++);
  const filtered =
    filter === 'all' ? items : items.filter((i) => i.status === filter);
  return (
    <div className="wi-inbox">
      {partial && (
        <div role="status">
          {queue.unavailableSources.map((source) => sourceLabels[source] || source).join('、')}暂不可用，仅显示已读取的待办。
          <Button variant="ghost" onClick={() => setRetry(n => n + 1)}>重试</Button>
        </div>
      )}
      <WorkOverview items={items} counts={counts} partial={partial} />
      <section className="wi-list">
        <header className="wi-list-heading">
          <h2>
            待办单据 <span>{items.length}</span>
          </h2>
          <div className="wi-filters" role="group" aria-label="按审查结果筛选">
            {filters.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={filter === k}
                onClick={() => setFilter(k)}
              >
                {labels[k]}
              </button>
            ))}
          </div>
        </header>
        <div className="wi-table-head wi-columns" aria-hidden="true">
          <span>单据</span>
          <span>申请人</span>
          <span>金额 / 时长</span>
          <span>审查结果</span>
          <span />
        </div>
        <ul className="wi-rows">
          {filtered.map(({ doc, result, status }) => (
            <li key={doc.id}>
              <button
                className="wi-row wi-columns"
                data-work-id={doc.id}
                type="button"
                onClick={() =>
                  w.openPanel({ kind: 'audit', id: doc.id, title: workDocumentTitle(doc) })
                }
              >
                <span className="wi-title-cell">
                  <WorkDocumentIcon doc={doc} />
                  <span>
                    <strong>{workDocumentTitle(doc)}</strong>
                    <small>{doc.id}</small>
                  </span>
                </span>
                <span className="wi-person">
                  {doc.person}
                  <small>{doc.department}</small>
                </span>
                <span className="wi-measure">{workMeasure(doc)}</span>
                <span className="wi-review-cell">
                  <span className={`wi-status wi-${status}`}>
                    <i />
                    {stateLabel(result)}
                  </span>
                  {result.risks.length > 0 && (
                    <small
                      title={result.risks.map((f) => f.rule.name).join('、')}
                    >
                      {result.risks[0]?.rule.name}
                      {result.risks.length > 1 &&
                        ` 等 ${result.risks.length} 项`}
                    </small>
                  )}
                </span>
                <Icon name="chevron" size={15} />
              </button>
            </li>
          ))}
        </ul>
        {!filtered.length && (
          <Empty title={items.length ? '当前筛选下暂无单据' : partial ? '已读取的范围内暂无待办' : '暂无待办单据'} />
        )}
      </section>
    </div>
  );
}

function WorkDossier({
  doc,
  state,
  fromInbox,
}: {
  doc: WorkDocument;
  state: RulesSubmissionState;
  fromInbox?: boolean;
}) {
  const w = useWorkspace();
  const result = summarizeWorkReview(doc, doc.decisionReview ?? readAuditReview(doc, state));
  return (
    <div className="wi-dossier" data-review-layout="split">
      {!fromInbox && (
        <button
          type="button"
          className="wi-back wi-back-to-inbox"
          onClick={() => w.openPanel({ kind: 'audit', id: 'batch', title: '待办单据' })}
        >
          <Icon name="back" size={14} />返回待办清单
        </button>
      )}
      <ReviewLayoutBody sample={{ doc, result }} note={state.notes?.[doc.id]} />
      <footer className="wi-footer">
        <Button variant="secondary" icon="chat" onClick={() => w.discussAuditDocument(doc)}>
          加入对话
        </Button>
        <a
          href={workDocumentHref(doc)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn secondary"
        >
          <Icon name="external" size={15} />
          查看单据
        </a>
        <WorkApprovalAction document={doc} />
      </footer>
    </div>
  );
}

function ScheduleRedirect() {
  const w = useWorkspace();
  useEffect(() => {
    w.closePanel();
    w.navigate('schedules');
  }, []);
  return null;
}

export function AuditPanel({
  panel,
  fromInbox,
}: {
  panel: PanelSpec;
  fromInbox?: boolean;
}) {
  const w = useWorkspace();
  const state: RulesSubmissionState =
    w.state.data.rulesSubmission ?? INITIAL_RULES_SUBMISSION;
  const docs: WorkDocument[] = w.state.data.auditDocuments ?? [];
  if (panel.id === 'schedule') return <ScheduleRedirect />;
  if (!panel.id || panel.id === 'batch')
    return <WorkList docs={docs} state={state} />;
  const doc = findWorkDocument(w.state.data, panel.id);
  return doc ? (
    <WorkDossier key={doc.id} doc={doc} state={state} fromInbox={fromInbox} />
  ) : (
    <Empty title="单据不存在" />
  );
}
