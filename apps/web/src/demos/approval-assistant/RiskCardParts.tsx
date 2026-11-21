import { Icon } from '../agent-workspace/ui';
import type { RiskAssessment } from './risk-assessment';
import { mascot } from './sample-types';
import type { CardProps } from './sample-types';
import './risk-card.css';

export function AssistantMark() {
  return (
    <div className="ra-brand">
      <img src={mascot} alt="" width="30" height="30" />
      <span>小智审批助手</span>
    </div>
  );
}

export function ScoreRing({ assessment }: { assessment: RiskAssessment }) {
  const { score, level } = assessment;
  return (
    <div
      className="ra-ring"
      role="img"
      aria-label={
        score === null
          ? `风险分暂不可用，${level}`
          : `风险分 ${score}/100，${level}，分数越高风险越高`
      }
      title="整单风险分 · 分数越高，风险越高"
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle
          className="ra-track"
          cx="50"
          cy="50"
          r="43"
          pathLength="100"
          fill="none"
        />
        {score !== null && score > 0 && (
          <circle
            className="ra-arc"
            cx="50"
            cy="50"
            r="43"
            pathLength="100"
            strokeDasharray={`${score} ${100 - score}`}
            fill="none"
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
      <span aria-hidden="true">
        <b>{score ?? '—'}</b>
        <small>{score === null ? '暂不计分' : '/ 100'}</small>
      </span>
    </div>
  );
}

export function AssessmentHeading({
  assessment,
}: {
  assessment: RiskAssessment;
}) {
  return (
    <div className="ra-level">
      <span>整单风险评估</span>
      <strong>{assessment.level}</strong>
    </div>
  );
}

export function RiskPoints({
  assessment,
  onEvidence,
  withEvidence = false,
}: {
  assessment: RiskAssessment;
  onEvidence?: CardProps['onEvidence'];
  withEvidence?: boolean;
}) {
  const { points, hidden, counts } = assessment;
  const emptyText =
    counts.executed && assessment.score === 0
      ? '未发现风险点'
      : '暂无可确认的风险点';
  return (
    <section className="ra-points" aria-label="风险概要">
      <h4>
        风险概要
        {points.length > 0 && <small>{points.length + hidden} 项</small>}
      </h4>
      {points.length ? (
        <ol>
          {points.map((point) => (
            <li key={point.key} className={`ra-point ra-${point.severity}`}>
              <div className="ra-point-head">
                <span className="ra-flag">
                  {point.severity === 'block'
                    ? '禁止'
                    : point.severity === 'warn'
                      ? '警告'
                      : '待核实'}
                </span>
                <strong>{point.title}</strong>
              </div>
              <p>{point.reason}</p>
              {withEvidence && point.expenseId && onEvidence && (
                <button
                  className="ra-evidence"
                  onClick={() => onEvidence(point.expenseId)}
                >
                  <Icon name="search" size={13} />
                  定位费用
                  <Icon name="chevron" size={12} />
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="ra-empty">{emptyText}</p>
      )}
      {hidden > 0 && (
        <p className="ra-more">另有 {hidden} 项，详见规则执行明细。</p>
      )}
    </section>
  );
}

const results = [
  { key: 'passed', label: '通过' },
  { key: 'warn', label: '警告' },
  { key: 'block', label: '禁止' },
  { key: 'pending', label: '待核实' },
] as const;
export function ExecutionBreakdown({
  assessment,
  visual = 'bar',
}: {
  assessment: RiskAssessment;
  visual?: 'bar' | 'metrics' | 'ledger';
}) {
  const { counts } = assessment;
  const shown = results.filter(
    ({ key }) => key !== 'pending' || counts.pending > 0,
  );
  return (
    <section
      className={`ra-execution ra-viz-${visual}`}
      aria-label="规则校验分布"
    >
      <h4>
        规则校验
        <span>
          已执行 <b>{counts.executed}</b> 条
        </span>
      </h4>
      {visual !== 'ledger' && (
        <div className="ra-bar" aria-hidden="true">
          {shown.map(
            ({ key }) =>
              counts[key] > 0 && (
                <i
                  className={`ra-${key}`}
                  key={key}
                  style={{ flexGrow: counts[key] }}
                />
              ),
          )}
        </div>
      )}
      <ul>
        {shown.map(({ key, label }) => (
          <li key={key} className={`ra-${key}`}>
            <i aria-hidden="true" />
            <span>{label}</span>
            <b>{counts[key]}</b>
          </li>
        ))}
      </ul>
      {(counts.notRun > 0 || counts.inapplicable > 0) && (
        <p className="ra-skipped">
          {[
            counts.notRun > 0 && `${counts.notRun} 条尚未执行`,
            counts.inapplicable > 0 && `${counts.inapplicable} 条不适用`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

export function RuleLink({ onRules }: Pick<CardProps, 'onRules'>) {
  return (
    <button className="ra-rules-link" onClick={onRules}>
      规则执行明细
      <Icon name="chevron" size={13} />
    </button>
  );
}
