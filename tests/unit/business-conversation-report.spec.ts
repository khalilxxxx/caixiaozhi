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
