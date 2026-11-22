import { Badge, Button, Icon } from './ui';
import { WorkDocumentIcon } from './WorkDocumentIcon';
import { useWorkspace, type ResultCard } from './workspace';
import { getSubmissionSummary, submissionLabels } from './SubmissionWorkspace';
import { resolveDraftId, readSubmissionState } from './submission-state';
import {
  draftCurrencyTotals,
  getDraftType,
  draftPeriod,
  type SubmissionDraft,
} from './submission-model';
import './submission-card.css';
import { activeSubmissionDefaults } from './submission-defaults';

function periodLabel(draft: SubmissionDraft) {
  const period = draftPeriod(draft);
  if (!period.start) return '日期待补充';
  const short = (value: string) => value.replace(/-/g, '.');
  if (
    getDraftType(draft) === 'travel' &&
    draft.legs.some((leg) => leg.isReturn && !leg.departureDate)
  )
    return `${short(period.start)} 出发 · 回程日期待补`;
  return period.start === period.end
    ? short(period.start)
    : `${short(period.start)} — ${short(period.end)}`;
}

function DraftPreview({ draft }: { draft: SubmissionDraft }) {
  if (getDraftType(draft) === 'travel') {
    const cities = draft.legs.length
      ? [
          draft.legs[0]!.departureCity || '出发城市待补充',
          ...draft.legs.map((leg) => leg.arrivalCity || '到达城市待补充'),
        ]
      : [];
    return (
      <div className="sc-business">
        {cities.length ? (
          <div className="sc-route" aria-label="差旅行程">
            {cities.slice(0, 5).map((city, index) => (
              <span key={index}>
                {index > 0 && <Icon name="arrow" size={13} />}
                <b>{city}</b>
              </span>
            ))}
            {cities.length > 5 && <span>等 {draft.legs.length} 段</span>}
          </div>
        ) : (
          <span className="sc-empty">行程待补充</span>
        )}
        <div className="sc-meta">
          <span>{periodLabel(draft)}</span>
          <span>{draft.legs.length} 段行程</span>
          {draft.legs.length > 0 && (
            <span>
              {[
                ...new Set(
                  draft.legs
                    .map((leg) => {
                      if (!leg.transport) return '';
                      const suggested = activeSubmissionDefaults(draft).some(
                        (entry) => entry.path === `legs.${leg.id}.transport`,
                      );
                      return `${leg.transport}${suggested ? '（建议）' : ''}`;
                    })
                    .filter(Boolean),
                ),
              ].join(' / ') || '交通工具待补充'}
            </span>
          )}
        </div>
      </div>
    );
  }
  const totals = draftCurrencyTotals(draft);
  return (
    <div className="sc-business sc-expense-summary">
      <div>
        <strong>
          {draft.expenses.length}
          <small>笔费用</small>
        </strong>
        <div className="sc-meta">
          {draft.expenses
            .slice(0, 2)
            .map((item) => item.name)
            .filter(Boolean)
            .join('、') || '费用待补充'}
          {draft.expenses.length > 2 ? '等' : ''}
        </div>
      </div>
      <div className="sc-money">
        {totals.length ? (
          totals.map((total) => (
            <strong key={total.currency}>
              <small>{total.currency}</small>
              {(total.amountCents / 100).toLocaleString('zh-CN', {
                minimumFractionDigits: 2,
              })}
            </strong>
          ))
        ) : (
          <span className="sc-empty">金额待补充</span>
        )}
      </div>
    </div>
  );
}

export function SubmissionCard({
  card,
  latest = true,
}: {
  card: ResultCard;
  latest?: boolean;
}) {
  const w = useWorkspace();
  const id = resolveDraftId(card.id);
  const requestId = card.data?.requestId || card.data?.receipt?.requestId;
  const receiptRequest = requestId
    ? readSubmissionState(w.state.data).requests.find(
        (request) => request.id === requestId,
      )
    : undefined;
  if (receiptRequest)
    return (
      <section className="sc-card" aria-label="提交回执">
        <header>
          <WorkDocumentIcon type={getDraftType(receiptRequest.snapshot)} size="compact" />
          <div>
            <strong>{receiptRequest.title}</strong>
            <small>{receiptRequest.businessId || receiptRequest.id}</small>
          </div>
          <Badge tone={receiptRequest.localStatus ? 'success' : 'warning'}>
            {receiptRequest.localStatus ? '本地已受理' : '待回执'}
          </Badge>
        </header>
        <p className="sc-purpose">{receiptRequest.snapshot.purpose}</p>
        <DraftPreview draft={receiptRequest.snapshot} />
        <footer>
          <span className="sc-version">本地模拟业务服务</span>
          <Button
            variant="primary"
            onClick={() =>
              w.openPanel({
                kind: 'submission',
                id: receiptRequest.draftId,
                title: submissionLabels[getDraftType(receiptRequest.snapshot)],
                data: { requestId: receiptRequest.id },
              })
            }
          >
            查看回执
          </Button>
        </footer>
      </section>
    );
  const current = getSubmissionSummary(w.state.data, id);
  const shown = latest ? current : card;
  const snapshot = shown.data?.snapshot as SubmissionDraft | undefined;
  const pending =
    current.status === '待回执' || current.status === '本地已受理';
  const open = (view?: string) =>
    w.openPanel({
      kind: 'submission',
      id,
      title: submissionLabels[getDraftType(id)],
      data: view ? { view } : undefined,
    });
  if (!latest)
    return (
      <details className="sc-history">
        <summary>
          <WorkDocumentIcon type={getDraftType(snapshot ?? id)} size="small" />
          <span>{card.title}</span>
          <small>
            {card.data?.version ? `v${card.data.version} · ` : ''}
            已被后续方案替换
          </small>
          <Icon name="chevron" size={13} />
        </summary>
        <div className="sc-history-content">
          {snapshot ? (
            <>
              <p>{snapshot.purpose || '事由待补充'}</p>
              <DraftPreview draft={snapshot} />
            </>
          ) : (
            <p>{card.subtitle || '历史记录'}</p>
          )}
          <div className="sc-history-actions">
            <Button disabled>旧方案不可提交</Button>
            <Button variant="link" onClick={() => open()}>
              查看当前单据
            </Button>
          </div>
        </div>
      </details>
    );
  const missing = Number(current.data?.missingCount ?? 0);
  return (
    <section
      className="sc-card"
      aria-label={`${submissionLabels[getDraftType(id)]}草稿卡片`}
    >
      <header>
        <WorkDocumentIcon type={getDraftType(snapshot ?? id)} size="compact" />
        <div>
          <strong>{submissionLabels[getDraftType(id)]}</strong>
          <small>
            {snapshot?.paymentCompany || '付款公司待补充'} ·{' '}
            {snapshot?.applicant || '申请人待补充'}
          </small>
        </div>
        <Badge tone={current.tone}>
          {current.status}
        </Badge>
      </header>
      <p className="sc-purpose">{snapshot?.purpose || '单据事由待补充'}</p>
      {snapshot && <DraftPreview draft={snapshot} />}
      {missing > 0 && !pending && (
        <div className="sc-pending">
          <Icon name="alert" size={14} />
          <span>
            还需补充 {missing} 项
            <span className="sc-pending-detail">
              {' '}
              · {(current.data?.missingItems ?? []).slice(0, 1).join('')}
            </span>
          </span>
        </div>
      )}
      <footer>
        <span className="sc-version">
          v{current.data?.version ?? 1}
          {current.status === '有未保存更改'
            ? ' · 未保存'
            : pending
              ? current.status === '本地已受理'
                ? ' · 本地已受理'
                : ' · 等待回执'
              : ' · 尚未提交'}
        </span>
        <div>
          <Button variant="link" onClick={() => open()}>
            查看详情
          </Button>
          <Button
            variant="primary"
            onClick={() => open(missing && !pending ? 'edit' : undefined)}
          >
            {pending ? '查看回执' : missing ? '补充信息' : '核对单据'}
          </Button>
        </div>
      </footer>
    </section>
  );
}
