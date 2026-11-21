import { useEffect, useRef } from 'react';
import { Icon } from './ui';
import { businessTime } from './time-format';
import {
  formatCents,
  type WorkspaceRule,
  type RuleFinding,
} from './RulesSubmission';
import type { summarizeWorkReview } from './work-review-model';

export type WorkReview = ReturnType<typeof summarizeWorkReview>;
type RuleState = 'risk' | 'pending' | 'passed' | 'inapplicable';
const groups: { key: RuleState; title: string }[] = [
  { key: 'risk', title: '有风险' },
  { key: 'pending', title: '待核实' },
  { key: 'passed', title: '未发现风险' },
  { key: 'inapplicable', title: '不适用' },
];

const fieldNames: Record<string, string> = {
  hotelNightCents: '住宿单价',
  amountCents: '金额',
  mealCents: '餐饮费用合计',
  invoiceUnique: '发票重复核验',
  attachment: '凭证完整性',
  days: '申请天数',
  purpose: '单据事由',
  reason: '费用用途',
  name: '名称',
  categoryName: '费用类型',
  date: '发生日期',
  arrivalCity: '到达城市',
  departureCity: '出发城市',
  description: '业务活动',
  notes: '说明',
  transport: '交通方式',
};

function evidenceText(path: string, quote: string) {
  const field = path.split('.').at(-1) || path;
  const line = path.replace(/^\$\./, '').match(/^(expenses|legs|activities)\[(\d+)\]/);
  const section = line
    ? `${({ expenses: '费用', legs: '行程', activities: '活动' } as Record<string, string>)[line[1] ?? '']}第 ${Number(line[2]) + 1} 项`
    : '';
  const label =
    [section, fieldNames[field]].filter(Boolean).join(' · ') || '单据原文';
  let value = quote;
  if (
    ['amountCents', 'mealCents', 'hotelNightCents'].includes(field) &&
    /^\d+$/.test(quote)
  )
    value =
      formatCents(Number(quote)) + (field === 'hotelNightCents' ? '/间夜' : '');
  else if (field === 'invoiceUnique' && quote === 'false')
    value = '存在重复发票';
  else if (field === 'attachment' && quote === 'false') value = '缺少必要凭证';
  return { label, value };
}

export function RuleRow({
  rule,
  finding,
  reason,
  evidence,
  state,
  onOpen,
}: {
  rule: WorkspaceRule;
  finding?: RuleFinding;
  reason?: string;
  evidence?: { path: string; quote: string }[];
  state: RuleState;
  onOpen?: () => void;
}) {
  const origin = rule.origin === 'personal' ? '个人规则' : '公司规则';
  return (
    <details
      className="wi-rule"
      onToggle={onOpen ? (event) => { if (event.currentTarget.open) onOpen(); } : undefined}
    >
      <summary>
        <i className={`wi-dot wi-${state}`} />
        <strong>{rule.name}</strong>
        <small>{origin}</small>
        <Icon name="down" size={15} />
      </summary>
      <div className="wi-rule-body">
        <div className="wi-rule-id">
          {rule.id} · v{rule.version}
        </div>
        {finding && <p>{finding.detail}</p>}
        {!finding && reason && <p>{reason}</p>}
        {finding?.state === 'hit' &&
          finding.actual &&
          !finding.detail.includes(finding.actual) &&
          finding.rule.metric !== 'semantic' && (
            <p>
              <b>实际情况</b>
              {finding.actual}
            </p>
          )}
        <p>
          <b>规则要求</b>
          {rule.description}
        </p>
        {state === 'inapplicable' && (
          <p>本单的类型或费用项目不在这项规则的适用范围内。</p>
        )}
        {evidence?.map((e, index) => {
          const { label, value } = evidenceText(e.path, e.quote);
          return (
            <blockquote key={index}>
              <small>{label}</small>
              {value}
            </blockquote>
          );
        })}
      </div>
    </details>
  );
}

export function WorkRuleDetails({
  result,
  goBack,
}: {
  result: WorkReview;
  goBack: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);
  const { counts, checked, stale, review, risks, pending } = result;
  const rows = {
    risk: risks.map((f) => f.rule),
    pending: pending.map((f) => f.rule),
    passed: review.passed,
    inapplicable: review.inapplicable,
  };
  return (
    <section className="wi-rules">
      <button className="wi-back" onClick={goBack} ref={back}>
        <Icon name="back" size={15} />
        返回单据详情
      </button>
      <h3>规则执行明细</h3>
      {checked ? (
        <>
          <p className="wi-rule-meta">
            本次纳入 {counts.total} 项规则，已执行 {counts.executed} 项。
            {result.checkedAt && (
              <time>审查于 {businessTime(result.checkedAt)}</time>
            )}
          </p>
          <div className="wi-breakdown">
            {groups.map((g) => (
              <div key={g.key}>
                <strong>{rows[g.key].length}</strong>
                <span>
                  <i className={`wi-dot wi-${g.key}`} />
                  {g.key === 'passed' ? '无风险' : g.title}
                </span>
              </div>
            ))}
          </div>
          <details className="wi-score-note">
            <summary>
              整单评分依据
              <Icon name="down" size={14} />
            </summary>
            <p>
              满分 100
              分，按未发现风险的规则数占适用规则数的比例计算。待核实项分别按有风险、无风险计入，得到分数区间。不适用项不参与评分。
            </p>
          </details>
          {groups
            .filter((g) => rows[g.key].length)
            .map((g) => (
              <section className="wi-rule-group" key={g.key}>
                <h4>
                  {g.title}
                  <small>{rows[g.key].length}</small>
                </h4>
                {rows[g.key].map((rule) => {
                  const finding = [...risks, ...pending].find(
                    (f) => f.rule.id === rule.id,
                  );
                  const evaluation = review.evaluations?.find(
                    (e) => e.ruleId === rule.id,
                  );
                  return (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      state={g.key}
                      finding={finding}
                      reason={evaluation?.reason}
                      evidence={finding?.evidence || evaluation?.evidence}
                    />
                  );
                })}
              </section>
            ))}
          {counts.total === 0 && <p>本单目前没有已启用的审单规则。</p>}
        </>
      ) : (
        <p className="wi-empty-review">
          {stale
            ? '单据或规则已变更，等待更新审查结果。'
            : '尚未取得本单的规则执行结果。'}
        </p>
      )}
    </section>
  );
}
