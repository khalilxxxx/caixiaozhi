import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const requireWeb = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
import {
  WorkspaceContext,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace';
import {
  publicFinancialReportHtml,
  continuePublicReport,
  PublicFinancialCard,
  PublicFinancialsPanel,
} from '../../apps/web/src/demos/agent-workspace/PublicFinancials';
import {
  financialMetricIds,
  financialMetricLabels,
  type FinancialReport,
} from '../../apps/web/src/demos/agent-workspace/public-financials-model';

function publicReport(): FinancialReport {
  const values = {
    revenue: 416161000000,
    costOfRevenue: 220960000000,
    researchAndDevelopment: 34550000000,
    sellingGeneralAndAdministrative: 27601000000,
    operatingIncome: 133050000000,
    netIncome: 112010000000,
  };
  const current = {
    year: 2025,
    periodStart: '2024-09-29',
    periodEnd: '2025-09-27',
    values,
  };
  const source = {
    dataset: {
      id: 'apple',
      version: 'sec-aapl-test',
      label: '苹果公司 2025 年 10-K',
      entity: 'Apple Inc.',
      currency: 'USD',
      displayUnit: '亿美元',
      years: [2025],
      source: {
        provider: 'SEC',
        url: 'https://www.sec.gov/xbrl',
        filingUrl: 'https://www.sec.gov/annual-report',
        accession: 'old-accession',
        filedAt: '2025-10-31',
        retrievedAt: '2026-11-17T09:00:00Z',
        sha256: 'apple-sha256',
      },
    },
    records: [current],
  };
  return {
    id: 'public-report-verification',
    title: '苹果公司 2025 财年财务分析报告',
    createdAt: '2026-11-17T09:00:00Z',
    version: 1,
    snapshot: {
      dataset: source.dataset,
      year: 2025,
      period: {
        start: current.periodStart,
        end: current.periodEnd,
        label: '2025财年',
      },
      metrics: financialMetricIds.map((id) => ({
        id,
        label: financialMetricLabels[id],
        value: values[id],
        previousValue: null,
        yoy: null,
        concept: `us-gaap:${id}`,
        unit: 'USD',
      })),
      totals: {
        ...values,
        operatingExpenses:
          values.researchAndDevelopment +
          values.sellingGeneralAndAdministrative,
        totalCosts: values.revenue - values.operatingIncome,
        grossProfit: values.revenue - values.costOfRevenue,
        operatingMargin: (values.operatingIncome / values.revenue) * 100,
        netMargin: (values.netIncome / values.revenue) * 100,
      },
      trend: source.records.map((record: typeof current) => ({
        ...record.values,
        year: record.year,
        periodStart: record.periodStart,
        periodEnd: record.periodEnd,
        totalCosts: record.values.revenue - record.values.operatingIncome,
        operatingMargin:
          (record.values.operatingIncome / record.values.revenue) * 100,
      })),
      findings: [{ title: '收入变化', text: '依据原始申报计算。' }],
      limitations: ['财年按原始起止日列示。'],
    },
  };
}

describe('公开财报离线报告', () => {
  it('单指标历史查询卡使用返回指标金额和同比', () => {
    const snapshot = publicReport().snapshot;
    snapshot.metrics = [
      {
        ...snapshot.metrics[2],
        label: '研发费用',
        value: 123456789.12,
        yoy: -3.45,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(WorkspaceContext.Provider, {
        value: {} as WorkspaceAPI,
        children: createElement(PublicFinancialCard, { snapshot }),
      }),
    );
    expect(html).toContain('研发费用');
    expect(html).toContain('1.23');
    expect(html).toContain('-3.45%');
    expect(html).not.toContain('无上年可比值');
    expect(html).not.toContain('营业收入');
    expect(html).not.toContain('营业利润');
  });

  it('历史卡片和分析抽屉优先使用保存的主体、期间和指标快照', () => {
    const snapshot = publicReport().snapshot;
    const html = renderToStaticMarkup(
      createElement(WorkspaceContext.Provider, {
        value: {} as WorkspaceAPI,
        children: createElement(PublicFinancialCard, {
          year: 2023,
          datasetId: 'apple',
          snapshot,
        }),
      }),
    );
    expect(html).toContain('Apple Inc.');
    expect(html).toContain('2025财年');
    expect(html).toContain('4,161.61');
    expect(html).toContain('生成报告');
    expect(html).not.toContain('海康威视');
    const panel = renderToStaticMarkup(
      createElement(WorkspaceContext.Provider, {
        value: {} as WorkspaceAPI,
        children: createElement(PublicFinancialsPanel, {
          panel: {
            kind: 'analysis',
            title: '历史查询',
            data: { year: 2023, datasetId: 'apple', snapshot },
          },
        }),
      }),
    );
    expect(panel).toContain('Apple Inc.');
    expect(panel).toContain('2025财年');
    const changed = renderToStaticMarkup(
      createElement(PublicFinancialsPanel, {
        panel: {
          kind: 'analysis',
          title: '历史查询',
          data: { datasetId: 'different-dataset', snapshot },
        },
      }),
    );
    expect(changed).toContain('此历史查询的数据源已切换');
    expect(changed).not.toContain('4,161.61');
  });

  it('人民币报告使用自身主体和年度，营业利润保留其他损益调节项', () => {
    const report = publicReport();
    report.title = '海康威视 2025年度财务分析报告';
    const query = report.snapshot;
    query.dataset = {
      ...query.dataset,
      entity: '杭州海康威视数字技术股份有限公司',
      shortName: '海康威视',
      label: '海康威视 2025年年度报告',
      currency: 'CNY',
      displayUnit: '亿元',
      periodLabel: '年度',
      source: {
        ...query.dataset.source,
        provider: '巨潮资讯·深交所法定披露',
        url: 'https://static.cninfo.com.cn/2025.pdf',
        filingUrl: 'https://static.cninfo.com.cn/2025.pdf',
        documents: [
          {
            id: 'annual-2025',
            label: '2025年年度报告',
            url: 'https://static.cninfo.com.cn/2025.pdf',
            sha256: 'annual-sha256',
          },
        ],
      },
    };
    query.period = {
      start: '2025-01-01',
      end: '2025-12-31',
      label: '2025年度',
    };
    query.totals = {
      revenue: 1000000000.25,
      costOfRevenue: 600000000.1,
      researchAndDevelopment: 100000000.05,
      sellingGeneralAndAdministrative: 80000000.07,
      operatingIncome: 180000000.02,
      netIncome: 150000000.04,
      operatingExpenses: 180000000.12,
      totalCosts: 780000000.22,
      grossProfit: 400000000.15,
      operatingMargin: 18,
      netMargin: 15,
      otherOperatingNet: -40000000.01,
    };
    query.metrics = query.metrics.map((metric) => ({
      ...metric,
      value: query.totals[metric.id],
      unit: 'CNY',
      label: metric.id === 'netIncome' ? '净利润' : metric.label,
      sources: [
        {
          year: 2025,
          documentId: 'annual-2025',
          page: 130,
          section: '合并利润表',
        },
      ],
    }));
    query.trend = [
      {
        ...query.totals,
        year: 2025,
        periodStart: '2025-01-01',
        periodEnd: '2025-12-31',
      },
    ];
    const html = publicFinancialReportHtml(report);
    expect(html).toContain('1,000,000,000.25');
    expect(html).toContain('合并净利润');
    expect(html).toContain('CNY 人民币');
    expect(html).toContain('合并净利率');
    expect(html).toContain('2025年度');
    expect(html).toContain('巨潮资讯·深交所法定披露');
    expect(html).toContain('三项成本费用合计');
    expect(html).toContain('其他营业损益净额');
    expect(html).toContain('-0.40');
    expect(html).toContain('计算项');
    expect(html).toContain('税金及附加');
    expect(html).toContain('130');
    expect(html).not.toContain('亿美元');
    expect(html).not.toContain('苹果');
    expect(html).not.toContain('SEC');
    expect(html).not.toContain('进一步扣除研发与销管费用，得到营业利润');
    const workspace = { closePanel: vi.fn(), send: vi.fn() };
    continuePublicReport(report, workspace, 1280);
    expect(workspace.send).toHaveBeenCalledWith(
      expect.stringContaining('海康威视2025年度'),
      [{ kind: 'report', id: report.id, title: report.title }],
    );
  });

  it('窄屏续聊收起报告并保留引用，桌面保留并排报告', () => {
    const report = publicReport();
    const workspace = { closePanel: vi.fn(), send: vi.fn() };
    continuePublicReport(report, workspace, 390);
    expect(workspace.closePanel).toHaveBeenCalledOnce();
    expect(workspace.send).toHaveBeenCalledWith(
      expect.stringContaining('2025'),
      [{ kind: 'report', id: report.id, title: report.title }],
    );
    workspace.closePanel.mockClear();
    continuePublicReport(report, workspace, 1280);
    expect(workspace.closePanel).not.toHaveBeenCalled();
  });
  it('包含完整章节、内联图表、美元原值、官方来源和版本', () => {
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = publicReport();
    const html = publicFinancialReportHtml(report);
    const messages = [...warnings.mock.calls];
    warnings.mockRestore();
    expect(messages).toEqual([]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<svg');
    expect(html).toContain('416,161,000,000');
    expect(html).toContain('4,161.61');
    expect(html).toContain('亿美元');
    expect(html).toContain('Apple Inc.');
    expect(html).not.toContain('海康威视');
    expect(html).toContain('2024-09-29');
    expect(html).toContain('原始指标与同比');
    expect(html).toContain(report.snapshot.dataset.source.filingUrl);
    expect(html).toContain(report.snapshot.dataset.source.sha256);
    expect(html).toContain('营业收入减去上述三项成本费用后，与披露的营业利润一致');
    expect(html).not.toContain('由销售费用与管理费用相加');
    expect(html).not.toContain('其他营业损益净额');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('转义标题和分析文字，保留历史报告自身的数据', () => {
    const report = publicReport();
    report.title = '<script>alert("title")</script>';
    report.snapshot.findings[0].text = '<img src=x onerror=alert(1)>';
    const html = publicFinancialReportHtml(report);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('public-report-verification');
  });
});
