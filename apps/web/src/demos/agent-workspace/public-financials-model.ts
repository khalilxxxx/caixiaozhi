export const financialMetricIds = [
  'revenue',
  'costOfRevenue',
  'researchAndDevelopment',
  'sellingGeneralAndAdministrative',
  'operatingIncome',
  'netIncome',
] as const;
export type FinancialMetricId =
  | (typeof financialMetricIds)[number]
  | 'attributableNetIncome'
  | 'operatingCashFlow';
export const financialMetricLabels: Record<FinancialMetricId, string> = {
  revenue: '营业收入',
  costOfRevenue: '营业成本',
  researchAndDevelopment: '研发费用',
  sellingGeneralAndAdministrative: '销售及管理费用',
  operatingIncome: '营业利润',
  netIncome: '净利润',
  attributableNetIncome: '归母净利润',
  operatingCashFlow: '经营活动现金流量净额',
};
export interface FinancialDocument {
  id: string;
  label: string;
  url: string;
  sha256: string;
  pages?: { income: number; cashFlow: number };
  filedAt?: string;
}
export interface FinancialMetricSource {
  year: number;
  documentId: string;
  page: number;
  section: string;
}
export interface FinancialSource {
  provider: string;
  url: string;
  filingUrl: string;
  accession?: string;
  documents?: FinancialDocument[];
  filedAt: string;
  retrievedAt: string;
  sha256: string;
}
export interface FinancialDataset {
  id: string;
  version: string;
  label: string;
  entity: string;
  shortName?: string;
  periodLabel?: string;
  currency: string;
  displayUnit: string;
  years: number[];
  source: FinancialSource;
}
export interface FinancialMetric {
  id: FinancialMetricId;
  label: string;
  value: number;
  previousValue: number | null;
  yoy: number | null;
  concept: string;
  unit: string;
  sources?: FinancialMetricSource[];
}
type FinancialValues = Record<(typeof financialMetricIds)[number], number> &
  Partial<Record<'attributableNetIncome' | 'operatingCashFlow', number>>;
export type FinancialTotals = FinancialValues & {
  otherOperatingNet?: number;
  financialExpenses?: number;
  sellingExpenses?: number;
  administrativeExpenses?: number;
  operatingExpenses: number;
  totalCosts: number;
  grossProfit: number;
  operatingMargin: number;
  netMargin: number;
};
export type FinancialTrend = FinancialValues & {
  sources?: Partial<Record<FinancialMetricId, FinancialMetricSource[]>>;
  year: number;
  periodStart: string;
  periodEnd: string;
  totalCosts: number;
  operatingMargin: number;
};
export interface FinancialQuery {
  dataset: FinancialDataset;
  year: number;
  period: { start: string; end: string; label: string };
  metrics: FinancialMetric[];
  totals: FinancialTotals;
  trend: FinancialTrend[];
  findings: { title: string; text: string }[];
  limitations: string[];
}
export interface FinancialReport {
  id: string;
  title: string;
  createdAt: string;
  version: number;
  snapshot: FinancialQuery;
}
export interface FinancialReportListItem {
  id: string;
  title: string;
  createdAt: string;
  year: number;
  version: number;
  datasetVersion: string;
  entity?: string;
  shortName?: string;
  currency?: string;
  sourceLabel?: string;
}

export function formatFinancialAmount(value: number) {
  return (value / 100000000).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatFinancialChange(value: number | null) {
  if (value === null) return '无可比数据';
  const formatted = value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
  return `${value > 0 ? '+' : ''}${formatted}%`;
}

export function financialCurrency(dataset: FinancialDataset) {
  const name = { CNY: '人民币', USD: '美元' }[dataset.currency];
  return name ? `${dataset.currency} ${name}` : dataset.currency;
}

export function financialEntity(dataset: FinancialDataset) {
  return dataset.shortName || dataset.entity;
}

export function financialPeriodLabel(query: FinancialQuery) {
  return (
    query.dataset.periodLabel ||
    query.period.label.replace(String(query.year), '').trim()
  );
}

export function financialMetricName(
  query: FinancialQuery,
  id: FinancialMetricId,
) {
  if (id === 'netIncome' && query.dataset.currency === 'CNY')
    return '合并净利润';
  return (
    query.metrics.find((metric) => metric.id === id)?.label ||
    financialMetricLabels[id]
  );
}

export function formatFinancialRaw(value: number) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function financialCsv(query: FinancialQuery) {
  const rows: (string | number)[][] = [
    [
      query.dataset.periodLabel || '年度/财年',
      '期间起始日',
      '期间结束日',
      '指标',
      `金额（${query.dataset.currency}）`,
      '年报来源',
      '来源文档',
      '页码',
      '章节',
      '数据版本',
    ],
  ];
  for (const period of query.trend) {
    for (const metric of query.metrics) {
      const value = period[metric.id];
      if (value == null) continue;
      const periodSources = period.sources?.[metric.id];
      const sources = periodSources?.length
        ? periodSources
        : metric.sources?.filter((source) => source.year === period.year) || [];
      const urls = sources
        .map(
          (source) =>
            query.dataset.source.documents?.find(
              (document) => document.id === source.documentId,
            )?.url,
        )
        .filter((url): url is string => Boolean(url));
      rows.push([
        period.year,
        period.periodStart,
        period.periodEnd,
        financialMetricName(query, metric.id),
        value.toFixed(2),
        urls.length ? urls.join(' | ') : query.dataset.source.filingUrl,
        sources?.map((source) => source.documentId).join(' | ') || '',
        sources?.map((source) => source.page).join(' | ') || '',
        sources?.map((source) => source.section).join(' | ') || '',
        query.dataset.version,
      ]);
    }
  }
  return rows
    .map((row) =>
      row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','),
    )
    .join('\r\n');
}
