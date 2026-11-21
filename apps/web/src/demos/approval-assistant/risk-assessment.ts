import type { RuleFinding } from '../agent-workspace/RulesSubmission';
import { hotelComparison, type ReviewSubject } from './sample-types';

export type RiskPoint = {
  key: string;
  title: string;
  reason: string;
  severity: 'block' | 'warn' | 'pending';
  expenseId?: string;
  relatedExpenseIds?: string[];
  documentTarget?: 'invoices' | 'attachments' | 'amount' | 'itinerary';
};

interface RuleCounts {
  passed: number;
  warn: number;
  block: number;
  pending: number;
  notRun: number;
  inapplicable: number;
  executed: number;
  total: number;
}

export interface RiskAssessment {
  score: number | null;
  level: string;
  tone: 'high' | 'medium' | 'low' | 'neutral';
  summary: string;
  points: RiskPoint[];
  hidden: number;
  counts: RuleCounts;
}

export const riskScoringDescription =
  '样板风险分越高，表示命中的规则风险越重。全部通过为 0 分（低风险）。仅有警告时从 25 分起，每多一项加 5 分，最高 55 分（中风险）。命中禁止规则从 60 分起，每多一项禁止加 15 分，每项警告再加 5 分，最高 100 分（高风险）。有待核实、未执行或无适用规则时暂不评分。';

const money = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const pointTitles = {
  attachment: '必要凭证缺失',
  invoiceUnique: '发票重复使用',
  hotelNight: '住宿费超标',
  meal: '餐饮费超出提醒额度',
};

function evidenceLocation(
  sample: ReviewSubject,
  finding: RuleFinding,
): Pick<RiskPoint, 'expenseId' | 'relatedExpenseIds' | 'documentTarget'> {
  const { doc, result } = sample;
  const evidence = finding.evidence?.length
    ? finding.evidence
    : (result.review.evaluations?.find((e) => e.ruleId === finding.rule.id)
        ?.evidence ?? []);
  const paths = evidence.map((e) => e.path.replace(/^\$\./, ''));
  const ids = new Set<string>();
  for (const path of paths) {
    const index = /^expenses\[(\d+)\](?:\.|$)/.exec(path)?.[1];
    const row = index === undefined ? undefined : doc.expenses?.[Number(index)];
    if (row) ids.add(row.id);
  }
  if (ids.size) {
    const relatedExpenseIds = [...ids];
    return { expenseId: relatedExpenseIds[0], relatedExpenseIds };
  }
  const metric = finding.rule.metric;
  if (
    doc.system === 'expense' &&
    (metric === 'invoiceUnique' || metric === 'validInvoice')
  )
    return { documentTarget: 'invoices' };
  if (metric === 'attachment' || paths.some((p) => /^files\[/.test(p)))
    return { documentTarget: 'attachments' };
  if (
    doc.legs?.length &&
    (metric === 'days' || paths.some((p) => /^legs\[/.test(p)))
  )
    return { documentTarget: 'itinerary' };
  if (
    doc.amountCents !== undefined &&
    doc.documentType !== 'travel' &&
    !/出差申请|差旅申请/.test(doc.kind) &&
    metric === 'amount'
  )
    return { documentTarget: 'amount' };
  return {};
}

export function riskPoint(
  sample: ReviewSubject,
  finding: RuleFinding,
): RiskPoint {
  const { doc } = sample;
  const { rule } = finding;
  const base: RiskPoint = {
    key: rule.id,
    title: rule.name,
    reason: finding.detail,
    severity: finding.state === 'unknown' ? 'pending' : rule.effect,
    ...evidenceLocation(sample, finding),
  };
  if (finding.state === 'unknown') return base;
  const title = pointTitles[rule.metric as keyof typeof pointTitles];
  if (title) base.title = title;
  if (rule.metric === 'hotelNight') {
    const hotel = hotelComparison(sample);
    if (hotel && hotel.limit * 100 === rule.thresholdMinor) {
      return {
        ...base,
        expenseId: base.expenseId ?? hotel.expenseId,
        reason: `${hotel.hotelName}实际 ¥${money.format(hotel.actual)}/间夜，标准 ¥${money.format(hotel.limit)}/间夜，${hotel.nights} 间夜合计超出 ¥${money.format(hotel.totalOver)}。`,
      };
    }
  }
  if (rule.metric === 'attachment') {
    const missing = doc.specificFields?.find(
      (f) => f.label === '待补凭证',
    )?.value;
    if (missing) {
      const unlinked = doc.expenses?.filter((e) => !e.sourceFileId);
      return {
        ...base,
        reason: `${missing}尚未提供，相关费用缺少核对依据。`,
        expenseId:
          base.expenseId ??
          (unlinked?.length === 1 ? unlinked[0]?.id : undefined),
      };
    }
  }
  if (
    rule.metric === 'meal' &&
    doc.mealCents !== undefined &&
    rule.thresholdMinor !== undefined &&
    doc.mealCents > rule.thresholdMinor
  ) {
    const mealLines = doc.expenses?.filter((e) =>
      e.categoryId.includes('meal'),
    );
    const matched =
      mealLines?.reduce((sum, line) => sum + line.amountCents, 0) ===
      doc.mealCents
        ? mealLines?.map((line) => line.id)
        : undefined;
    return {
      ...base,
      expenseId: base.expenseId ?? matched?.[0],
      relatedExpenseIds: base.relatedExpenseIds ?? matched,
      reason: `餐饮合计 ¥${money.format(doc.mealCents / 100)}，超过 ¥${money.format(rule.thresholdMinor / 100)} 的提醒额度，差额 ¥${money.format((doc.mealCents - rule.thresholdMinor) / 100)}。`,
    };
  }
  return base;
}

function verdict(
  sample: ReviewSubject,
  counts: RuleCounts,
  points: RiskPoint[],
): Pick<RiskAssessment, 'score' | 'level' | 'tone' | 'summary'> {
  const { result, doc } = sample;
  if (result.stale || !result.checked)
    return {
      score: null,
      level: '待评估',
      tone: 'neutral',
      summary: result.stale
        ? '单据或规则已更新，需重新审查后评定风险。'
        : '尚无本次审查结果，完成规则校验后可评定风险。',
    };
  if (counts.inapplicable === counts.total)
    return {
      score: null,
      level: '不适用',
      tone: 'neutral',
      summary: `当前规则范围未覆盖这张${doc.kind}，暂无整单风险评分。`,
    };
  if (counts.pending || counts.notRun) {
    const hits = counts.block + counts.warn;
    const known = hits ? `已发现 ${hits} 项规则命中，` : '';
    return {
      score: null,
      level: '待评估',
      tone: 'neutral',
      summary: `${known}另有检查等待执行或核实，待结果完整后评定风险。`.replace(
        /^另有/,
        '部分',
      ),
    };
  }
  if (counts.block) {
    const topics = points
      .filter((p) => p.severity === 'block')
      .slice(0, 2)
      .map((p) => p.title)
      .join('、');
    const additional = counts.warn ? `，另有 ${counts.warn} 项警告需核对` : '';
    return {
      score: Math.min(100, 60 + (counts.block - 1) * 15 + counts.warn * 5),
      level: '高风险',
      tone: 'high',
      summary: `本单因${topics}命中禁止规则${additional}。${counts.warn ? '' : '审批前需复核相关费用。'}`,
    };
  }
  if (counts.warn)
    return {
      score: Math.min(55, 25 + (counts.warn - 1) * 5),
      level: '中风险',
      tone: 'medium',
      summary: `本单触发 ${counts.warn} 项提醒，审批时需核对${points[0]?.title ?? '相关事项'}的依据。`,
    };
  return {
    score: 0,
    level: '低风险',
    tone: 'low',
    summary: `本单 ${counts.passed} 项适用规则均已通过，本次审查未发现需要复核的问题。`,
  };
}

export function assessRisk(sample: ReviewSubject): RiskAssessment {
  const { result } = sample;
  const applicable = new Map(
    result.review.applicable.map((rule) => [rule.id, rule]),
  );
  const inapplicable = new Set(
    result.review.inapplicable.map((rule) => rule.id),
  ).size;
  const counts: RuleCounts = {
    passed: 0,
    warn: 0,
    block: 0,
    pending: 0,
    notRun: 0,
    inapplicable,
    executed: 0,
    total: applicable.size + inapplicable,
  };
  const hits = new Map(result.risks.map((f) => [f.rule.id, f]));
  const uncertain = new Map(result.pending.map((f) => [f.rule.id, f]));
  const passed = new Set(result.review.passed.map((r) => r.id));
  const groups: Record<RiskPoint['severity'], RiskPoint[]> = {
    block: [],
    warn: [],
    pending: [],
  };

  for (const id of applicable.keys()) {
    const hit = hits.get(id);
    const pending = uncertain.get(id);
    if (result.stale || !result.checked) counts.notRun++;
    else if (hit) {
      counts[hit.rule.effect]++;
      groups[hit.rule.effect].push(riskPoint(sample, hit));
    } else if (pending && pending.executed !== false) {
      counts.pending++;
      groups.pending.push(riskPoint(sample, pending));
    } else if (!pending && passed.has(id)) counts.passed++;
    else counts.notRun++;
  }
  counts.executed = counts.passed + counts.warn + counts.block + counts.pending;
  // 一笔业务事实可以命中多条规则，保留规则计数，展示要点只取最高处置级别。
  const unique = new Map<string, RiskPoint>();
  for (const point of [...groups.block, ...groups.warn, ...groups.pending]) {
    const fact = JSON.stringify([
      point.title,
      point.reason,
      point.relatedExpenseIds ?? point.expenseId,
      point.documentTarget,
    ]);
    if (!unique.has(fact)) unique.set(fact, point);
  }
  const points = [...unique.values()].slice(0, 5);
  return {
    ...verdict(sample, counts, points),
    counts,
    points,
    hidden: unique.size - points.length,
  };
}
