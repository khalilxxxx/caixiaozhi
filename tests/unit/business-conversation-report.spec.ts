import { expect, it } from 'vitest';
import { businessReportHtml } from '../../apps/web/src/demos/agent-workspace/BusinessAnalysisResults';

it('离线报告保留不同问题的数据来源、原有币种与负数，并转义上传文件名', () => {
  const html = businessReportHtml({
    id: 'business-report-test',
    title: '会话分析报告',
    createdAt: '2026-11-21T16:00:00Z',
    sections: [
      {
        kind: 'expenseCsv',
        question: '汇总费用',
        snapshot: {
          title: '费用汇总',
          scopeLabel: '部门差旅',
          source: '<b>费用</b>.csv',
          unit: '元',
          metrics: [{ label: '净额', value: 1200, unit: '元' }],
          breakdown: [
            { name: '差旅', value: 2000 },
            { name: '退款', value: -800 },
          ],
        },
      },
      {
        kind: 'publicFinance',
        question: '去年利润多少？',
        snapshot: {
          title: '年度利润',
          scopeLabel: '2025 财年',
          source: '公司年报',
          unit: '亿美元',
          metrics: [{ label: '营业利润', value: 12.52, unit: '亿美元' }],
          breakdown: [{ name: '营业利润', value: 12.52 }],
        },
      },
    ],
  });
  expect(html).toContain('&lt;b&gt;费用&lt;/b&gt;.csv');
  expect(html).toContain('-800');
  expect(html).toContain('亿美元');
  expect(html).toContain('公司年报');
  expect(html).not.toContain('<script');
});

it('把同一来源的不同分析命名为独立章节，离线目录能定位到对应图表', () => {
  const snapshot = {
    title: '差旅管理看板',
    departmentLabel: '财务部',
    source: '合成台账',
    recordCount: 1,
    scope: {
      system: 'travel' as const,
      departmentIds: ['finance'],
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    },
    metrics: [
      { id: 'tripCount', label: '出差行程', value: 1, unit: '次' },
      { id: 'travelAmount', label: '差旅费用', value: 1000, unit: '元' },
    ],
    comparison: {
      kind: 'previousMonth' as const, days: 31,
      startDate: '2026-08-01', endDate: '2026-08-31', values: { tripCount: 2 },
    },
    trend: [],
    breakdown: [],
    ranking: [{ name: '宋欣', department: '财务部', amount: 1000, trips: 1 }],
    routes: [],
    departments: [],
  };
  const html = businessReportHtml({
    id: 'report-1',
    title: '九月分析',
    createdAt: '2026-11-22',
    sections: [
      { focus: 'overview', question: '看下差旅情况', snapshot },
      { focus: 'ranking', question: '谁的差旅费最高？', snapshot },
      { focus: 'overview', metricId: 'tripCount', question: '出差多少次？', snapshot },
    ],
  });
  expect(html).toContain('aria-label="报告目录"');
  expect(html).toMatch(/<h2[^>]*>员工差旅费排行<\/h2>/);
  expect(html).toContain('href="#report-section-2"');
  expect(html).toContain('id="report-section-2"');
  expect(html).toContain('对比上个自然月');
  expect(html).toContain('减少 50%');
  expect(html).not.toContain('引用报告追问');
  const tripSection = html.split('id="report-section-3"')[1]!;
  expect(tripSection).toContain('部门出差行程');
  expect(tripSection).toContain('bb-single-metric');
  expect(tripSection).not.toContain('差旅费用');
  expect(tripSection).not.toContain('bb-chart-grid');
});
