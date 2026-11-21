import { describe, expect, it } from 'vitest';
import {
  formatFinancialAmount,
  formatFinancialChange,
  financialCsv,
  financialMetricIds,
  type FinancialQuery,
} from '../../apps/web/src/demos/agent-workspace/public-financials-model';

describe('公开财报金额和导出', () => {
  it('2025查询的三年CSV优先读取趋势逐年来源，保留2023全部八项来源', () => {
    const ids = [
      ...financialMetricIds,
      'attributableNetIncome',
      'operatingCashFlow',
    ] as const;
    const metrics = ids.map((id) => ({
      id,
      label: id,
      sources: [2024, 2025].map((year) => ({
        year,
        documentId: 'annual-2025',
        page: id === 'operatingCashFlow' ? 153 : 151,
        section: '合并报表',
      })),
    }));
    const trend = [2023, 2024, 2025].map((year) => ({
      year,
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      ...Object.fromEntries(ids.map((id) => [id, 123456789.12])),
      sources: Object.fromEntries(
        ids.map((id) => [
          id,
          [
            {
              year,
              documentId: year === 2023 ? 'annual-2024' : 'annual-2025',
              page:
                year === 2023
                  ? id === 'operatingCashFlow'
                    ? 163
                    : 161
                  : id === 'operatingCashFlow'
                    ? 153
                    : 151,
              section:
                id === 'operatingCashFlow' ? '合并现金流量表' : '合并利润表',
            },
          ],
        ]),
      ),
    }));
    const query = {
      dataset: {
        currency: 'CNY',
        version: 'cninfo-test',
        source: {
          filingUrl: 'https://static.cninfo.com.cn/2025.pdf',
          documents: [
            {
              id: 'annual-2024',
              url: 'https://static.cninfo.com.cn/2024.pdf',
              pages: { income: 161, cashFlow: 163 },
            },
            {
              id: 'annual-2025',
              url: 'https://static.cninfo.com.cn/2025.pdf',
              pages: { income: 151, cashFlow: 153 },
            },
          ],
        },
      },
      metrics,
      trend,
    } as FinancialQuery;
    const rows = financialCsv(query)
      .split('\r\n')
      .filter((row) => row.startsWith('"2023"'));
    expect(rows).toHaveLength(8);
    for (const [index, row] of rows.entries()) {
      expect(row).toContain(
        `"${ids[index] === 'netIncome' ? '合并净利润' : ids[index]}"`,
      );
      expect(row).toContain('"https://static.cninfo.com.cn/2024.pdf"');
      expect(row).toContain('"annual-2024"');
      expect(row).toContain(
        ids[index] === 'operatingCashFlow'
          ? '"163","合并现金流量表"'
          : '"161","合并利润表"',
      );
      expect(row).not.toContain('2025.pdf');
    }
    query.trend[0].sources = {};
    query.metrics[0].sources = [];
    const fallback = financialCsv(query).split('\r\n')[1];
    expect(fallback).toContain('https://static.cninfo.com.cn/2025.pdf');
  });

  it('保留小数金额的展示精度，缺少比较期保持为空', () => {
    expect(formatFinancialAmount(416161000000)).toBe('4,161.61');
    expect(formatFinancialAmount(-123456789.12)).toBe('-1.23');
    expect(formatFinancialChange(6.425)).toBe('+6.43%');
    expect(formatFinancialChange(null)).toBe('无可比数据');
    expect(formatFinancialChange(0)).toBe('0.00%');
  });

  it('CSV 保留人民币两位原值、指标名称及逐年页码和年报来源', () => {
    const csv = financialCsv({
      dataset: {
        currency: 'CNY',
        periodLabel: '年度',
        version: 'cninfo-hikvision-test',
        source: {
          filingUrl: 'https://static.cninfo.com.cn/2025.pdf',
          documents: [
            { id: 'annual-2024', url: 'https://static.cninfo.com.cn/2024.pdf' },
            { id: 'annual-2025', url: 'https://static.cninfo.com.cn/2025.pdf' },
          ],
        },
      },
      metrics: [
        {
          id: 'revenue',
          label: '营业收入',
          sources: [
            {
              year: 2024,
              documentId: 'annual-2024',
              page: 120,
              section: '合并利润表',
            },
            {
              year: 2025,
              documentId: 'annual-2025',
              page: 130,
              section: '合并利润表',
            },
          ],
        },
        {
          id: 'netIncome',
          label: '合并净利润',
          sources: [
            {
              year: 2025,
              documentId: 'annual-2025',
              page: 130,
              section: '合并利润表',
            },
          ],
        },
      ],
      trend: [
        {
          year: 2024,
          periodStart: '2024-01-01',
          periodEnd: '2024-12-31',
          revenue: 100000000.12,
          netIncome: -1234567.89,
        },
        {
          year: 2025,
          periodStart: '2025-01-01',
          periodEnd: '2025-12-31',
          revenue: 120000000.34,
          netIncome: 2345678.01,
        },
      ],
    } as FinancialQuery);
    const rows = csv.split('\r\n');
    expect(csv).toContain('金额（CNY）');
    expect(rows[1]).toContain('100000000.12');
    expect(rows[1]).toContain('https://static.cninfo.com.cn/2024.pdf');
    expect(rows[1]).toContain('120');
    expect(rows[1]).not.toContain('2025.pdf');
    expect(csv).toContain('-1234567.89');
    expect(csv).toContain('合并净利润');
    expect(csv).toContain('cninfo-hikvision-test');
    expect(rows).toHaveLength(5);
  });

  it('历史美元快照继续导出自己的币种、财年期间和 SEC 来源', () => {
    const csv = financialCsv({
      dataset: {
        currency: 'USD',
        version: 'sec-aapl-test',
        source: { filingUrl: 'https://www.sec.gov/example' },
      },
      metrics: [{ id: 'revenue', label: '营业收入' }],
      trend: [
        {
          year: 2025,
          periodStart: '2024-09-29',
          periodEnd: '2025-09-27',
          revenue: 416161000000,
        },
      ],
    } as FinancialQuery);
    expect(csv).toContain('416161000000.00');
    expect(csv).toContain('2024-09-29');
    expect(csv).toContain('金额（USD）');
    expect(csv).toContain('https://www.sec.gov/example');
    expect(csv).not.toContain('CNY');
  });
});
