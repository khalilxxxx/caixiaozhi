import { describe, expect, it } from 'vitest';
import {
  cases,
  type ApprovalCase,
} from '../../apps/web/src/demos/approval-assistant/preview-data';
import { assessRisk } from '../../apps/web/src/demos/approval-assistant/risk-assessment';
import { summarizeWorkReview } from '../../apps/web/src/demos/agent-workspace/work-review-model';
import type { RuleFinding } from '../../apps/web/src/demos/agent-workspace/RulesSubmission';

const hotel = cases.find((c) => c.id === 'hotel')!;
function withFindings(
  states: ('block' | 'warn' | 'pending' | 'notRun')[],
  repeated = false,
): ApprovalCase {
  const findings: RuleFinding[] = states.map((state, i) => ({
    rule: {
      ...hotel.result.risks[0]!.rule,
      id: String(i),
      name: repeated ? '同一风险' : `风险 ${i + 1}`,
      metric: 'semantic',
      effect: state === 'block' ? 'block' : 'warn',
    },
    state: state === 'pending' || state === 'notRun' ? 'unknown' : 'hit',
    actual: '已核对单据',
    expected: '业务依据已提供',
    detail: repeated ? '同一业务事实。' : `第 ${i + 1} 项核对结果。`,
    executed: state !== 'notRun',
  }));
  const review = {
    ...hotel.result.review,
    applicable: findings.map((f) => f.rule),
    passed: [],
    findings,
  };
  return {
    ...hotel,
    result: summarizeWorkReview(hotel.doc, {
      checked: true,
      stale: false,
      review,
    }),
  };
}

describe('审批助手样板整单风险', () => {
  it('一次禁止即为高风险，并使用同一住宿费用行计算真实差额', () => {
    const risk = assessRisk(hotel);
    expect(risk).toMatchObject({
      score: 60,
      level: '高风险',
      counts: { passed: 9, warn: 0, block: 1, executed: 10, total: 10 },
    });
    expect(risk.points).toHaveLength(1);
    expect(risk.points[0]).toMatchObject({
      key: 'R002',
      expenseId: 'item-1',
      severity: 'block',
    });
    for (const detail of ['780/间夜', '600/间夜', '2 间夜', '360'])
      expect(risk.points[0]?.reason).toContain(detail);
  });

  it('按规则处置排序，分别核对混合样本中的费用行、凭证和餐饮额度', () => {
    const risk = assessRisk(cases.find((c) => c.id === 'mixed')!);
    expect(risk).toMatchObject({
      score: 80,
      counts: {
        total: 4,
        executed: 4,
        block: 2,
        warn: 1,
        passed: 1,
        pending: 0,
        notRun: 0,
      },
    });
    expect(risk.points.map((p) => p.severity)).toEqual([
      'block',
      'block',
      'warn',
    ]);
    expect(risk.points.find((p) => p.key === 'R004')).toMatchObject({
      expenseId: 'mixed-exp-taxi',
      reason: expect.stringContaining('出租车行程单'),
    });
    expect(risk.points.find((p) => p.key === 'P001')).toMatchObject({
      expenseId: 'mixed-exp-meal',
      reason: expect.stringContaining('180'),
    });
  });

  it('区分已执行待核实与尚未执行，在信息不完整时保留已知风险', () => {
    const risk = assessRisk(withFindings(['notRun', 'pending', 'block']));
    expect(risk).toMatchObject({
      score: null,
      tone: 'neutral',
      counts: { block: 1, pending: 1, notRun: 1, total: 3, executed: 2 },
    });
    expect(risk.points.map((p) => p.severity)).toEqual(['block', 'pending']);
    expect(
      assessRisk({
        ...hotel,
        result: { ...hotel.result, checked: false, stale: true },
      }),
    ).toMatchObject({
      score: null,
      points: [],
      counts: { block: 0, executed: 0, notRun: 10 },
    });
  });

  it('全通过对应低风险，零适用不评分', () => {
    expect(assessRisk(cases.find((c) => c.id === 'clear')!)).toMatchObject({
      score: 0,
      level: '低风险',
      points: [],
    });
    expect(assessRisk(cases.find((c) => c.id === 'na')!)).toMatchObject({
      score: null,
      level: '不适用',
      points: [],
      counts: { executed: 0, inapplicable: 3 },
    });
  });

  it('从规则证据定位每条费用，忽略重复引用和不存在的行', () => {
    const sample = withFindings(['block']);
    const rule = sample.result.risks[0]!;
    rule.evidence = [
      { path: '$.expenses[1].name', quote: '高铁' },
      { path: 'expenses[0].name', quote: '酒店' },
      { path: '$.expenses[1].amountCents', quote: '14600' },
      { path: '$.expenses[98].name', quote: '不存在' },
    ];
    expect(assessRisk(sample).points[0]).toMatchObject({
      expenseId: sample.doc.expenses![1]!.id,
      relatedExpenseIds: [
        sample.doc.expenses![1]!.id,
        sample.doc.expenses![0]!.id,
      ],
    });
  });

  it('整单层面的发票核验只定位发票集合', () => {
    const sample = withFindings(['block']);
    sample.result.risks[0]!.rule.metric = 'invoiceUnique';
    const point = assessRisk(sample).points[0]!;
    expect(point.documentTarget).toBe('invoices');
    expect(point.expenseId).toBeUndefined();
  });

  it('只展示五条独立要点并保留完整统计，风险分遵守上限', () => {
    const risk = assessRisk(
      withFindings([
        'warn',
        'warn',
        'warn',
        'block',
        'warn',
        'block',
        'block',
        'block',
      ]),
    );
    expect(risk).toMatchObject({ score: 100, hidden: 3 });
    expect(risk.points.map((p) => p.severity)).toEqual([
      'block',
      'block',
      'block',
      'block',
      'warn',
    ]);
    expect(assessRisk(withFindings(['warn'])).score).toBe(25);
    expect(assessRisk(withFindings(Array(10).fill('warn'))).score).toBe(55);
    const shared = assessRisk(withFindings(['warn', 'block'], true));
    expect(shared.points).toHaveLength(1);
    expect(shared.points[0]?.severity).toBe('block');
    expect(shared.counts).toMatchObject({ block: 1, warn: 1, executed: 2 });
  });
});
