import { useId, useState } from 'react';
import { RuleRow } from '../agent-workspace/WorkRuleDetails';
import { Icon } from '../agent-workspace/ui';
import { AssessmentSummary } from './AssistantHeaderOptions';
import {
  riskPoint,
  type RiskAssessment,
  type RiskPoint,
} from './risk-assessment';
import { hotelComparison, type ReviewSubject } from './sample-types';
import './wide-review-panel.css';

const outcomes = {
  block: { label: '禁止', state: 'risk' },
  warn: { label: '警告', state: 'risk' },
  passed: { label: '通过', state: 'passed' },
  pending: { label: '待核实', state: 'pending' },
  notRun: { label: '尚未执行', state: 'pending' },
  inapplicable: { label: '不适用', state: 'inapplicable' },
} as const;
type Outcome = keyof typeof outcomes;
const mainOutcomes = ['passed', 'warn', 'block'] as const;
const otherOutcomes = ['pending', 'notRun', 'inapplicable'] as const;

function verdictText(sample: ReviewSubject, assessment: RiskAssessment) {
  const { result, doc } = sample;
  const { counts } = assessment;
  let summary = assessment.summary;
  const suggestions = new Set<string>();
  if (result.checked && !result.stale) {
    const known = new Map(
      result.risks.map((finding) => [finding.rule.id, finding]),
    );
    const matched = assessment.points
      .filter((point) => point.severity !== 'pending')
      .map((point) => known.get(point.key))
      .filter((finding) => finding !== undefined);
    for (const finding of matched) {
      switch (finding.rule.metric) {
        case 'hotelNight':
          suggestions.add('请核对入住间夜和适用标准，并请申请人说明超标原因。');
          break;
        case 'attachment': {
          const missing = doc.specificFields?.find(
            (field) => field.label === '待补凭证',
          )?.value;
          suggestions.add(
            missing ? `请补齐${missing}。` : '请补齐规则要求的业务凭证。',
          );
          break;
        }
        case 'invoiceUnique':
          suggestions.add(
            '请对照历史报销记录核对票据，确认重复后移除相应费用。',
          );
          break;
        case 'meal':
          suggestions.add('请核对餐费合计与对应票据，补充超出提醒额度的原因。');
          break;
      }
    }
    if (
      matched.length === 1 &&
      counts.block + counts.warn === 1 &&
      !counts.pending &&
      !counts.notRun
    ) {
      const finding = matched[0]!;
      const hotel =
        finding.rule.metric === 'hotelNight' ? hotelComparison(sample) : null;
      if (hotel) {
        summary = `住宿费超过适用标准，${hotel.nights} 间夜合计超出 ¥${hotel.totalOver.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}。`;
      } else if (finding.rule.metric === 'invoiceUnique') {
        summary = '核验记录显示，本单包含已在其他报销单使用的发票。';
      }
    }
  }
  return { summary, advice: [...suggestions].slice(0, 2).join('') };
}

function InlineRules({
  sample,
  onChoosePoint,
}: {
  sample: ReviewSubject;
  onChoosePoint: (point: RiskPoint) => void;
}) {
  const { result } = sample;
  const { review } = result;
  const current = result.checked && !result.stale;
  const hits = new Map(result.risks.map((f) => [f.rule.id, f]));
  const pending = new Map(result.pending.map((f) => [f.rule.id, f]));
  const passed = new Set(review.passed.map((r) => r.id));
  const groups = new Map<Outcome, typeof review.applicable>();
  for (const rule of new Map(
    review.applicable.map((r) => [r.id, r]),
  ).values()) {
    const hit = hits.get(rule.id);
    const unresolved = pending.get(rule.id);
    let outcome: Outcome = 'notRun';
    if (current) {
      if (hit) outcome = hit.rule.effect;
      else if (unresolved)
        outcome = unresolved.executed === false ? 'notRun' : 'pending';
      else if (passed.has(rule.id)) outcome = 'passed';
    }
    const rules = groups.get(outcome) ?? [];
    rules.push(rule);
    groups.set(outcome, rules);
  }
  groups.set('inapplicable', [
    ...new Map(review.inapplicable.map((r) => [r.id, r])).values(),
  ]);
  const [selected, setSelected] = useState<Outcome | null>(null);
  const controls = useId();
  const count = (key: Outcome) => groups.get(key)?.length ?? 0;
  const executed =
    count('block') + count('warn') + count('passed') + count('pending');
  const activeRules = selected && groups.get(selected);

  return (
    <section className="wr-rules" aria-label="规则执行结果">
      <div className="wr-section-heading">
        <h4>规则执行结果</h4>
        <span>已执行 {executed} 条</span>
      </div>
      <div className="wr-metrics" role="group" aria-label="规则执行结果">
        {mainOutcomes.map((key) => (
          <button
            key={key}
            className={`wr-filter wr-metric wr-${key}`}
            type="button"
            aria-label={`${outcomes[key].label} ${count(key)} 条`}
            aria-expanded={selected === key}
            aria-controls={controls}
            disabled={!count(key)}
            onClick={() => setSelected(selected === key ? null : key)}
          >
            <span className="wr-metric-label">
              <i />
              {outcomes[key].label}
            </span>
            <strong>{count(key)}</strong>
            <span aria-hidden="true" className="wr-metric-meter">
              <i
                style={{
                  width: `${executed ? (100 * count(key)) / executed : 0}%`,
                }}
              />
            </span>
          </button>
        ))}
      </div>
      {otherOutcomes.some(count) && (
        <div className="wr-other-outcomes">
          {otherOutcomes.filter(count).map((key) => (
            <button
              key={key}
              className={`wr-filter wr-${key}`}
              type="button"
              aria-expanded={selected === key}
              aria-controls={controls}
              onClick={() => setSelected(selected === key ? null : key)}
            >
              {outcomes[key].label} {count(key)}
              <Icon name="down" size={12} />
            </button>
          ))}
        </div>
      )}
      {!executed && !otherOutcomes.some(count) && (
        <p className="wr-empty">本单暂无纳入审查的规则。</p>
      )}
      <div id={controls} className="wr-rows" hidden={!activeRules?.length}>
        {selected &&
          activeRules?.map((rule) => {
            const finding = current
              ? (hits.get(rule.id) ?? pending.get(rule.id))
              : undefined;
            const evaluation =
              current && !['notRun', 'inapplicable'].includes(selected)
                ? review.evaluations?.find((item) => item.ruleId === rule.id)
                : undefined;
            return (
              <RuleRow
                key={rule.id}
                onOpen={
                  finding
                    ? () => onChoosePoint(riskPoint(sample, finding))
                    : undefined
                }
                rule={rule}
                state={outcomes[selected].state}
                finding={finding}
                reason={evaluation?.reason}
                evidence={
                  finding?.evidence?.length
                    ? finding.evidence
                    : evaluation?.evidence
                }
              />
            );
          })}
      </div>
    </section>
  );
}

export function WideReviewPanel({
  sample,
  assessment,
  selectedExpenseId,
  onEvidence,
  onDocumentEvidence,
}: {
  sample: ReviewSubject;
  assessment: RiskAssessment;
  selectedExpenseId?: string;
  onEvidence: (expenseId: string, relatedIds?: string[]) => void;
  onDocumentEvidence?: (
    target: NonNullable<RiskPoint['documentTarget']>,
  ) => void;
}) {
  const { summary, advice } = verdictText(sample, assessment);
  const [active, setActive] = useState<{ doc: string; key: string } | null>(
    null,
  );

  function choosePoint(point: RiskPoint) {
    if (point.expenseId) {
      setActive({ doc: sample.doc.id, key: point.key });
      onEvidence(point.expenseId, point.relatedExpenseIds);
    } else if (point.documentTarget && onDocumentEvidence) {
      setActive({ doc: sample.doc.id, key: point.key });
      onDocumentEvidence(point.documentTarget);
    }
  }

  return (
    <div className="wr-panel">
      <AssessmentSummary
        assessment={assessment}
        summary={summary}
        advice={advice}
      />
      <InlineRules
        key={sample.doc.id}
        sample={sample}
        onChoosePoint={choosePoint}
      />
      {assessment.points.length > 0 && (
        <section className="wr-points" aria-label="待核对事项">
          <div className="wr-section-heading">
            <h4>待核对事项</h4>
            <span>{assessment.points.length + assessment.hidden} 项</span>
          </div>
          <ul>
            {assessment.points.map((point) => {
              const linked =
                point.expenseId || (point.documentTarget && onDocumentEvidence);
              const isActive =
                active?.doc === sample.doc.id
                  ? active.key === point.key
                  : !!point.expenseId && selectedExpenseId === point.expenseId;
              const contents = (
                <>
                  <span className="wr-point-heading">
                    <span className="wr-severity">
                      {outcomes[point.severity].label}
                    </span>
                    <strong>{point.title}</strong>
                    {linked && <Icon name="chevron" size={14} />}
                  </span>
                  <span className="wr-point-reason">{point.reason}</span>
                </>
              );
              return (
                <li key={point.key} className={`wr-${point.severity}`}>
                  {linked ? (
                    <button
                      type="button"
                      className="wr-point"
                      aria-current={isActive || undefined}
                      onClick={() => choosePoint(point)}
                    >
                      {contents}
                    </button>
                  ) : (
                    <div className="wr-point">{contents}</div>
                  )}
                </li>
              );
            })}
          </ul>
          {assessment.hidden > 0 && (
            <p className="wr-empty">
              其余 {assessment.hidden} 项可在规则执行结果中查看。
            </p>
          )}
        </section>
      )}
    </div>
  );
}
