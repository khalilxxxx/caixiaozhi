import { useEffect, useId, useRef, useState } from 'react';
import { api } from './runtime-client';
import type { DemoRule } from './rule-center-model';
import type { RuleReview } from './RulesSubmission';
import { Badge, Button } from './ui';
import { businessTime } from './time-format';

interface SampleCase {
  id: string;
  name: string;
  ruleId: string;
  system: 'oa' | 'expense';
  documentType: 'travel' | 'expense' | 'personal';
  scenario: 'hit' | 'clear' | 'unknown';
  document: {
    purpose?: string | null;
    expenses?: { name?: string; reason?: string; amount?: string }[];
    legs?: {
      departureCity?: string;
      arrivalCity?: string;
      departureDate?: string;
    }[];
    activities?: { description?: string }[];
  };
}
interface SampleResult {
  review: RuleReview & {
    evaluations?: {
      ruleId: string;
      state: 'MATCHED' | 'NOT_MATCHED' | 'INSUFFICIENT_EVIDENCE';
      reason: string;
      evidence: { path: string; quote: string }[];
    }[];
  };
  checkedAt: string;
  model?: string;
}

export function RuleSampleTest({
  rule,
  disabled = false,
}: {
  rule: DemoRule;
  disabled?: boolean;
}) {
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [cases, setCases] = useState<SampleCase[]>([]);
  const [caseId, setCaseId] = useState('');
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SampleResult | null>(null);
  const [retry, setRetry] = useState(0);
  const request = useRef(0);
  const current = useRef('');
  const key = JSON.stringify([rule, disabled, caseId]);
  current.current = key;
  const applicable = cases.filter(
    (item) =>
      item.system === rule.system &&
      (!rule.documentTypes?.length ||
        rule.documentTypes.includes(item.documentType)),
  );
  const ownCases = applicable.filter((item) => item.ruleId === rule.id);
  const choices = ownCases.length ? ownCases : applicable;
  const selected = choices.find((item) => item.id === caseId) ?? choices[0];

  useEffect(() => {
    request.current += 1;
    setResult(null);
    setError('');
    setRunning(false);
  }, [key]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!open || cases.length) return;
    let active = true;
    setLoading(true);
    api<{ cases: SampleCase[] }>('/rules/demo-cases')
      .then((response) => {
        if (active) setCases(response.cases);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : '样例加载失败，请重试。',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, retry]);

  const run = async () => {
    if (!selected || disabled || running) return;
    const requestId = ++request.current;
    const submittedKey = key;
    setRunning(true);
    setResult(null);
    setError('');
    try {
      const response = await api<SampleResult>('/rules/test', {
        rule,
        caseId: selected.id,
      });
      if (request.current === requestId && current.current === submittedKey)
        setResult(response);
    } catch (reason) {
      if (request.current === requestId)
        setError(
          reason instanceof Error ? reason.message : '测试失败，请重试。',
        );
    } finally {
      if (request.current === requestId) setRunning(false);
    }
  };
  const inapplicable = result && result.review.applicable.length === 0;
  return (
    <details
      className="rc-sample-test"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>样例测试</summary>
      {open && (
        <div className="rc-sample-body">
          {loading ? (
            <p role="status">正在加载样例…</p>
          ) : (
            <>
              <label htmlFor={selectId}>测试样例</label>
              <select
                id={selectId}
                value={selected?.id ?? ''}
                disabled={running || !choices.length}
                onChange={(event) => setCaseId(event.target.value)}
              >
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name.replace(/^合成样例：/, '')}
                  </option>
                ))}
              </select>
              {selected && (
                <div className="rc-sample-input">
                  <Badge>合成数据</Badge>
                  <dl>
                    <div>
                      <dt>事由</dt>
                      <dd>{selected.document.purpose || '未提供'}</dd>
                    </div>
                    {!!selected.document.legs?.length && (
                      <div>
                        <dt>行程</dt>
                        <dd>
                          {selected.document.legs.map((leg, index) => (
                            <p key={index}>
                              {leg.departureDate} · {leg.departureCity} →{' '}
                              {leg.arrivalCity}
                            </p>
                          ))}
                        </dd>
                      </div>
                    )}
                    {!!selected.document.activities?.length && (
                      <div>
                        <dt>业务安排</dt>
                        <dd>
                          {selected.document.activities.map((item, index) => (
                            <p key={index}>{item.description || '未提供'}</p>
                          ))}
                        </dd>
                      </div>
                    )}
                    {!!selected.document.expenses?.length && (
                      <div>
                        <dt>费用明细</dt>
                        <dd>
                          {selected.document.expenses.map((item, index) => (
                            <p key={index}>
                              {item.name} {item.amount ? `¥${item.amount}` : ''}{' '}
                              · {item.reason || '用途未提供'}
                            </p>
                          ))}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
              {!choices.length && !error && <p>暂无适用的测试样例。</p>}
              <div className="rc-sample-actions">
                <Button
                  onClick={run}
                  disabled={disabled || running || !selected}
                  icon="spark"
                >
                  {running ? '正在检查…' : '运行测试'}
                </Button>
                {disabled && <span>请先重新生成规则</span>}
              </div>
            </>
          )}
          {error && (
            <div className="rc-feedback error" role="alert">
              <span>{error}</span>
              {!cases.length && (
                <Button onClick={() => setRetry((value) => value + 1)}>
                  重新加载
                </Button>
              )}
            </div>
          )}
          {result && (
            <div className="rc-sample-result" role="status">
              <div className="rc-sample-result-head">
                <Badge
                  tone={
                    inapplicable
                      ? 'neutral'
                      : result.review.status === 'attention'
                        ? 'warning'
                        : result.review.status === 'clear'
                          ? 'success'
                          : 'neutral'
                  }
                >
                  {inapplicable
                    ? '不适用'
                    : result.review.status === 'attention'
                      ? '命中风险'
                      : result.review.status === 'clear'
                        ? '未命中'
                        : '待核实'}
                </Badge>
                <time>{businessTime(result.checkedAt)}</time>
              </div>
              {result.review.evaluations?.length
                ? result.review.evaluations.map((evaluation) => (
                    <div key={evaluation.ruleId}>
                      <p>{evaluation.reason}</p>
                      {evaluation.evidence.map((item, index) => (
                        <blockquote key={index}>{item.quote}</blockquote>
                      ))}
                    </div>
                  ))
                : result.review.findings.map((finding) => (
                    <p key={finding.rule.id}>{finding.detail}</p>
                  ))}
              {result.model && <small>执行模型：{result.model}</small>}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
