import type {
  readAuditReview,
  ReviewDoc,
  RuleFinding,
} from './RulesSubmission';

/** 旧版快照把金额保存为整数分，本层只格式化已存的命中事实。 */
function readableHit(finding: RuleFinding): RuleFinding {
  const { rule, actual } = finding;
  if (actual === 'False') {
    const reason =
      rule.metric === 'invoiceUnique'
        ? '发票核对记录显示，本单存在已用于其他报销单的发票。'
        : rule.metric === 'attachment'
          ? '单据缺少本项规则要求的证明材料。'
          : undefined;
    if (reason) return { ...finding, actual: reason, detail: reason };
  }
  const labels = {
    amount: '单据金额',
    hotelNight: '住宿单价',
    meal: '餐饮合计',
    days: '申请天数',
  };
  if (!/^\d+$/.test(actual) || !(rule.metric in labels)) return finding;
  const key = rule.metric as keyof typeof labels;
  const limit = key === 'days' ? rule.thresholdDays : rule.thresholdMinor;
  if (limit === undefined) return finding;
  const format = (value: number) =>
    key === 'days'
      ? `${value}天`
      : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${key === 'hotelNight' ? '/间夜' : ''}`;
  const value = format(Number(actual));
  return {
    ...finding,
    actual: value,
    detail: `${labels[key]}为${value}，超过${rule.origin === 'personal' ? '提醒阈值' : '规则上限'}${format(limit)}。`,
  };
}

export function summarizeWorkReview(
  doc: ReviewDoc,
  audit: ReturnType<typeof readAuditReview>,
) {
  const { checked, stale, checkedAt, review } = audit;
  const risks = checked
    ? review.findings.filter((f) => f.state === 'hit').map(readableHit)
    : [];
  const pending = checked
    ? review.findings.filter((f) => f.state === 'unknown')
    : [];
  const applicable = review.applicable.length;
  const counts = {
    total: applicable + review.inapplicable.length,
    executed: checked
      ? applicable - pending.filter((f) => f.executed === false).length
      : 0,
    hit: risks.length,
    pending: pending.length,
    passed: checked ? review.passed.length : 0,
    inapplicable: checked ? review.inapplicable.length : 0,
  };
  let score: string | null = null;
  if (applicable && (counts.passed || counts.hit)) {
    const lower = Math.round((100 * counts.passed) / applicable);
    const upper = Math.round(
      (100 * (counts.passed + counts.pending)) / applicable,
    );
    score = lower === upper ? String(lower) : `${lower}–${upper}`;
  }
  return {
    documentId: doc.id,
    checked,
    stale,
    checkedAt,
    score,
    scoreMax: 100,
    counts,
    risks,
    pending,
    review,
  };
}
