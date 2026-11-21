import { useEffect, useRef } from 'react';
import { RuleRow } from '../agent-workspace/WorkRuleDetails';
import { businessTime } from '../agent-workspace/time-format';
import { Icon } from '../agent-workspace/ui';
import type { ApprovalCase } from './preview-data';
import { assessRisk, riskScoringDescription } from './risk-assessment';

export function PreviewRuleDetails({
  sample,
  goBack,
}: {
  sample: ApprovalCase;
  goBack: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);
  const { result } = sample;
  const { counts, score, level } = assessRisk(sample);
  const findings = [...result.risks, ...result.pending];
  const review = result.review;
  const unexecuted = new Set(
    result.pending.filter((f) => f.executed === false).map((f) => f.rule.id),
  );
  const completed = new Set([
    ...review.passed.map((r) => r.id),
    ...findings.filter((f) => f.executed !== false).map((f) => f.rule.id),
  ]);
  const groups = [
    {
      id: 'block',
      name: '禁止',
      state: 'risk',
      count: counts.block,
      rules: result.risks
        .filter((f) => f.rule.effect === 'block')
        .map((f) => f.rule),
    },
    {
      id: 'warn',
      name: '警告',
      state: 'risk',
      count: counts.warn,
      rules: result.risks
        .filter((f) => f.rule.effect === 'warn')
        .map((f) => f.rule),
    },
    {
      id: 'passed',
      name: '通过',
      state: 'passed',
      count: counts.passed,
      rules: review.passed,
    },
    {
      id: 'pending',
      name: '待核实',
      state: 'pending',
      count: counts.pending,
      rules: result.pending
        .filter((f) => f.executed !== false)
        .map((f) => f.rule),
    },
    {
      id: 'notRun',
      name: '尚未执行',
      state: 'pending',
      count: counts.notRun,
      rules: review.applicable.filter(
        (r) => !result.checked || unexecuted.has(r.id) || !completed.has(r.id),
      ),
    },
    {
      id: 'inapplicable',
      name: '不适用',
      state: 'inapplicable',
      count: counts.inapplicable,
      rules: review.inapplicable,
    },
  ] as const;
  const applicable = counts.total - counts.inapplicable;
  const rate =
    applicable > 0 && result.checked && counts.notRun + counts.pending === 0
      ? Math.round((100 * counts.passed) / applicable)
      : null;
  return (
    <section className="wi-rules lab-rule-details">
      <button type="button" className="wi-back" ref={back} onClick={goBack}>
        <Icon name="back" size={15} />
        返回单据详情
      </button>
      <h3>规则执行明细</h3>
      <p className="wi-rule-meta">
        纳入 {counts.total} 项，已执行 {counts.executed} 项。
        {result.checked && result.checkedAt && (
          <time>审查于 {businessTime(result.checkedAt)}</time>
        )}
      </p>
      <div className="lab-rule-stats" aria-label="规则结果分布">
        {groups
          .filter(
            (g) => ['block', 'warn', 'passed'].includes(g.id) || g.count > 0,
          )
          .map((g) => (
            <div key={g.id} className={'lab-rule-count lab-outcome-' + g.id}>
              <small>{g.name}</small>
              <strong>{g.count}</strong>
            </div>
          ))}
      </div>
      <details className="wi-score-note">
        <summary>
          风险分计算依据{' '}
          <span>{score !== null ? `${score} / 100 · ${level}` : level}</span>
          <Icon name="down" size={14} />
        </summary>
        <p>{riskScoringDescription}</p>
        {rate !== null && (
          <p>
            本单共 {applicable} 项适用规则，{counts.passed} 项通过，通过率为{' '}
            {rate}%。风险分根据命中项的严重程度计算。
          </p>
        )}
      </details>
      {!result.checked && (
        <p className="wi-empty-review">
          {result.stale
            ? '单据或规则已变更，等待当前版本的审查结果。'
            : '尚未取得本单的规则执行结果。'}
        </p>
      )}
      {groups
        .filter((g) => g.count > 0)
        .map((g) => (
          <section className={`wi-rule-group lab-outcome-${g.id}`} key={g.id}>
            <h4>
              {g.name}
              <small>{g.count}</small>
            </h4>
            {g.rules.map((rule) => {
              const finding = result.checked
                ? findings.find((f) => f.rule.id === rule.id)
                : undefined;
              const evalResult = result.checked
                ? review.evaluations?.find((e) => e.ruleId === rule.id)
                : undefined;
              return (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  state={g.state}
                  finding={finding}
                  reason={evalResult?.reason}
                  evidence={
                    finding?.evidence?.length
                      ? finding.evidence
                      : evalResult?.evidence
                  }
                />
              );
            })}
          </section>
        ))}
    </section>
  );
}
