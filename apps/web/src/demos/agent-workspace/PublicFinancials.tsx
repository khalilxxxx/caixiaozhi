import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from './runtime-client';
import { businessTime } from './time-format';
import { useWorkspace, type PanelSpec, type WorkspaceAPI } from './workspace';
import { Badge, Button, Icon } from './ui';
import {
  financialCsv,
  financialMetricName,
  financialCurrency,
  financialEntity,
  financialPeriodLabel,
  formatFinancialRaw,
  formatFinancialAmount,
  formatFinancialChange,
  type FinancialMetricId,
  type FinancialQuery,
  type FinancialReport,
  type FinancialReportListItem,
} from './public-financials-model';
import reportStyles from './analytics-report.css?raw';
import publicStyles from './public-financials.css?raw';
import './analytics-report.css';
import './public-financials.css';

const basePath = '/analytics/public';
const years = [2025, 2024, 2023];
const colors = ['#3974df', '#439489', '#9b7dba'];

function usePublicResource<T>(path: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<{
    path: string;
    value: T | null;
    error: string;
  }>({ path: '', value: null, error: '' });
  useEffect(() => {
    if (!path) return;
    let active = true;
    setResource({ path, value: null, error: '' });
    api<T>(basePath + path).then(
      (value) => active && setResource({ path, value, error: '' }),
      (error) =>
        active && setResource({ path, value: null, error: error.message }),
    );
    return () => {
      active = false;
    };
  }, [path, attempt]);
  return {
    value: resource.path === path ? resource.value : null,
    error: resource.path === path ? resource.error : '',
    reload: () => setAttempt((previous) => previous + 1),
  };
}

function LoadState({ error, retry }: { error: string; retry: () => void }) {
  if (error) {
    return (
      <div className="pf-feedback" role="alert">
        <p>{error}</p>
        <Button onClick={retry}>重新加载</Button>
      </div>
    );
  }
  return (
    <div className="pf-feedback" role="status">
      正在读取公开财报…
    </div>
  );
}

function saveFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadMetrics(query: FinancialQuery) {
  saveFile(
    `${financialEntity(query.dataset)}-${query.trend.map((row) => row.year).join('-')}指标.csv`,
    '\ufeff' + financialCsv(query),
    'text/csv;charset=utf-8',
  );
}

function publicReportPanel(report: FinancialReport): PanelSpec {
  return {
    kind: 'report',
    id: report.id,
    title: report.title,
    data: { publicFinance: true, year: report.snapshot.year },
  };
}

function FinancialMetrics({ query }: { query: FinancialQuery }) {
  const hasCashFlow =
    query.totals.attributableNetIncome != null &&
    query.totals.operatingCashFlow != null;
  const primaryIds: FinancialMetricId[] = hasCashFlow
    ? ['revenue', 'attributableNetIncome', 'operatingCashFlow']
    : ['revenue', 'operatingIncome', 'netIncome'];
  const metrics =
    query.metrics.length < (hasCashFlow ? 8 : 6)
      ? query.metrics
      : query.metrics
          .filter((metric) => primaryIds.includes(metric.id))
          .sort(
            (first, second) =>
              primaryIds.indexOf(first.id) - primaryIds.indexOf(second.id),
          );
  return (
    <div className="ar-metrics pf-metrics">
      {metrics.map((metric) => (
        <div key={metric.id} data-metric={metric.id}>
          <span>{financialMetricName(query, metric.id)}</span>
          <strong>
            {formatFinancialAmount(metric.value)}
            <small>{query.dataset.displayUnit}</small>
          </strong>
          <small>
            {metric.yoy == null
              ? '无上年可比值'
              : `同比 ${formatFinancialChange(metric.yoy)}`}
          </small>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ query }: { query: FinancialQuery }) {
  const series = ['revenue', 'totalCosts', 'operatingIncome'] as const;
  const labels = [
    financialMetricName(query, 'revenue'),
    '三项成本费用合计',
    financialMetricName(query, 'operatingIncome'),
  ];
  const values = query.trend.flatMap((row) => series.map((id) => row[id]));
  const maximum = Math.max(...values, 1);
  const step = 10 ** Math.floor(Math.log10(maximum));
  const ceiling = Math.ceil(maximum / step) * step;
  const floor = Math.min(0, ...values);
  const bottom = 225;
  const height = 175;
  const yFor = (value: number) =>
    bottom - ((value - floor) / (ceiling - floor)) * height;
  const baseline = yFor(0);
  return (
    <figure className="pf-figure">
      <figcaption>
        <h3>年度经营趋势</h3>
        <span>单位 {query.dataset.displayUnit}</span>
      </figcaption>
      <div className="pf-chart-scroll">
        <svg
          viewBox="0 0 680 285"
          role="img"
          aria-label={`${query.trend.map((row) => row.year).join('至')} 营业收入、三项成本费用合计与营业利润对比`}
        >
          {[0, 1, 2, 3, 4].map((tick) => {
            const y = bottom - (tick / 4) * height;
            return (
              <g key={tick}>
                <line x1="58" y1={y} x2="660" y2={y} stroke="#e6ebf2" />
                <text x="48" y={y + 4} textAnchor="end" className="pf-axis">
                  {(
                    (floor + ((ceiling - floor) * tick) / 4) /
                    100000000
                  ).toLocaleString('zh-CN')}
                </text>
              </g>
            );
          })}
          {query.trend.map((row, index) => (
            <g key={row.year}>
              {series.map((id, column) => {
                const value = row[id];
                const barHeight = Math.abs(yFor(value) - baseline);
                const x = 95 + index * 194 + column * 42;
                return (
                  <g key={id}>
                    <rect
                      x={x}
                      y={Math.min(yFor(value), baseline)}
                      width="30"
                      height={barHeight}
                      rx="3"
                      fill={colors[column]}
                    >
                      <title>{`${row.year}${financialPeriodLabel(query)}${labels[column]} ${formatFinancialRaw(value)} ${query.dataset.currency}`}</title>
                    </rect>
                    <text
                      x={x + 15}
                      y={value < 0 ? yFor(value) + 14 : yFor(value) - 8}
                      textAnchor="middle"
                      className="pf-bar-value"
                    >
                      {formatFinancialAmount(value)}
                    </text>
                  </g>
                );
              })}
              <text
                x={152 + index * 194}
                y="252"
                textAnchor="middle"
                className="pf-axis"
              >
                {row.year}
                {financialPeriodLabel(query)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="pf-legend">
        {labels.map((label, index) => (
          <span key={label}>
            <i style={{ background: colors[index] }} />
            {label}
          </span>
        ))}
      </div>
    </figure>
  );
}

function CostChart({ query }: { query: FinancialQuery }) {
  const ids = [
    'costOfRevenue',
    'researchAndDevelopment',
    'sellingGeneralAndAdministrative',
  ] as const;
  return (
    <figure className="pf-figure">
      <figcaption>
        <h3>{query.period.label}成本费用结构</h3>
        <span>金额 {query.dataset.displayUnit} · 占三项成本费用合计</span>
      </figcaption>
      <div className="pf-costs">
        {ids.map((id, index) => {
          const value = query.totals[id];
          const share =
            query.totals.totalCosts === 0
              ? 0
              : (value / query.totals.totalCosts) * 100;
          return (
            <div className="pf-cost-row" key={id}>
              <span>{financialMetricName(query, id)}</span>
              <div className="pf-cost-track">
                <i
                  style={{
                    width: `${Math.max(0, Math.min(100, share))}%`,
                    background: colors[index],
                  }}
                />
              </div>
              <strong>{formatFinancialAmount(value)}</strong>
              <small>{share.toFixed(2)}%</small>
            </div>
          );
        })}
      </div>
      <p className="pf-chart-note">
        三项成本费用合计 {formatFinancialAmount(query.totals.totalCosts)}{' '}
        {query.dataset.displayUnit}，其中研发及销管费用
        {formatFinancialAmount(query.totals.operatingExpenses)}{' '}
        {query.dataset.displayUnit}。
      </p>
    </figure>
  );
}

function FinancialTable({ query }: { query: FinancialQuery }) {
  return (
    <div
      className="pf-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="原始财务指标，可横向滚动"
    >
      <table className="pf-table">
        <caption>
          {query.period.label}原始财务指标 · 单位{' '}
          {financialCurrency(query.dataset)}
        </caption>
        <thead>
          <tr>
            <th>指标</th>
            <th>本期</th>
            <th>上期</th>
            <th>同比</th>
            <th>指标来源</th>
          </tr>
        </thead>
        <tbody>
          {query.metrics.map((metric) => (
            <tr key={metric.id} data-concept={metric.concept}>
              <th scope="row" title={metric.concept}>
                {financialMetricName(query, metric.id)}
                {metric.id === 'sellingGeneralAndAdministrative' &&
                (query.totals.sellingExpenses != null ||
                  query.totals.otherOperatingNet != null) &&
                !metric.label.includes('计算项')
                  ? '（计算项）'
                  : ''}
              </th>
              <td>{formatFinancialRaw(metric.value)}</td>
              <td>
                {metric.previousValue == null
                  ? '—'
                  : formatFinancialRaw(metric.previousValue)}
              </td>
              <td>{formatFinancialChange(metric.yoy)}</td>
              <td>
                {metric.sources
                  ?.filter(
                    (source) =>
                      source.year === query.year ||
                      source.year === query.year - 1,
                  )
                  .map((source, index) => {
                    const document = query.dataset.source.documents?.find(
                      (item) => item.id === source.documentId,
                    );
                    return (
                      <div key={`${source.year}-${source.documentId}-${index}`}>
                        <a
                          href={document?.url || query.dataset.source.filingUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {source.year}年 · 第{source.page}页 · {source.section}
                        </a>
                      </div>
                    );
                  }) || '年报披露'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FinancialFindings({ query }: { query: FinancialQuery }) {
  return (
    <div className="pf-findings">
      {query.findings.map((finding) => (
        <div key={finding.title}>
          <h3>{finding.title}</h3>
          <p>{finding.text}</p>
        </div>
      ))}
    </div>
  );
}

function FinancialSources({ query }: { query: FinancialQuery }) {
  const { source } = query.dataset;
  return (
    <div className="pf-source">
      <dl>
        <dt>披露主体</dt>
        <dd>{query.dataset.entity}</dd>
        <dt>统计期间</dt>
        <dd>
          {query.period.start} 至 {query.period.end} · {query.period.label}
        </dd>
        <dt>币种与单位</dt>
        <dd>
          {financialCurrency(query.dataset)}，图表按{query.dataset.displayUnit}
          展示，原始指标保留两位小数。
        </dd>
        <dt>披露信息</dt>
        <dd>
          {query.dataset.label} · {source.provider} · {source.filedAt} 披露
          {source.accession && ` · ${source.accession}`}
        </dd>
        <dt>计算口径</dt>
        <dd>
          同比为（本期－上期）÷上期。三项成本费用合计为营业成本、研发费用及销售管理费用之和。
          {query.totals.sellingExpenses != null &&
            '销售及管理费用由销售费用与管理费用相加得到。'}
          {query.totals.otherOperatingNet != null &&
            '其他营业损益净额为营业利润－营业收入＋三项成本费用合计，反映税金及附加、财务费用、其他收益、投资收益及减值等项目的净影响。'}
          营业利润采用年报披露值。营业利润率为营业利润÷营业收入。
        </dd>
        <dt>数据获取</dt>
        <dd>{businessTime(source.retrievedAt)} · 公开披露快照</dd>
        <dt>数据版本</dt>
        <dd>{query.dataset.version}</dd>
        <dt>原始数据 SHA-256</dt>
        <dd className="pf-hash">{source.sha256}</dd>
        {source.documents?.map((document) => (
          <div className="pf-source-document" key={document.id}>
            <dt>{document.label}</dt>
            <dd>
              <a href={document.url} target="_blank" rel="noreferrer">
                {document.label}
              </a>
              {document.filedAt && ` · ${document.filedAt} 披露`}
              <div className="pf-hash">SHA-256 {document.sha256}</div>
            </dd>
          </div>
        ))}
      </dl>
      <p className="pf-source-links">
        <a href={source.filingUrl} target="_blank" rel="noreferrer">
          {source.provider} · 年报原文
        </a>
        {source.url !== source.filingUrl && (
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.provider} · 原始数据
          </a>
        )}
      </p>
    </div>
  );
}

function ReportDocument({ report }: { report: FinancialReport }) {
  const query = report.snapshot;
  return (
    <article className="ar-document pf-document">
      <header className="ar-document-header">
        <h1>{report.title}</h1>
        <p>
          {query.period.start} 至 {query.period.end}
          <span>
            {financialCurrency(query.dataset)} · {query.period.label}
          </span>
        </p>
        <div className="ar-document-meta">
          <span>
            {query.dataset.source.provider} · {query.dataset.label}
          </span>
          <span>
            {businessTime(report.createdAt)} 生成 · v{report.version}
          </span>
        </div>
      </header>
      <section id="pf-summary" className="ar-report-section">
        <h2>报告摘要</h2>
        <FinancialMetrics query={query} />
        <FinancialFindings query={query} />
      </section>
      <section id="pf-trend" className="ar-report-section">
        <h2>经营趋势</h2>
        <TrendChart query={query} />
        <p>
          图表按各年度对应来源及原始期间列示。{query.period.label}营业利润率为{' '}
          {query.totals.operatingMargin.toFixed(2)}%，
          {query.dataset.currency === 'CNY' ? '合并净利率' : '净利率'}为{' '}
          {query.totals.netMargin.toFixed(2)}%。
        </p>
      </section>
      <section id="pf-cost" className="ar-report-section">
        <h2>成本与费用</h2>
        <CostChart query={query} />
        <p>
          营业收入 {formatFinancialAmount(query.totals.revenue)}{' '}
          {query.dataset.displayUnit}，营业成本{' '}
          {formatFinancialAmount(query.totals.costOfRevenue)}{' '}
          {query.dataset.displayUnit}， 毛利{' '}
          {formatFinancialAmount(query.totals.grossProfit)}{' '}
          {query.dataset.displayUnit}。营业利润{' '}
          {formatFinancialAmount(query.totals.operatingIncome)}{' '}
          {query.dataset.displayUnit}。
          {query.totals.otherOperatingNet != null ? (
            <>
              其他营业损益净额（计算项）为{' '}
              {formatFinancialAmount(query.totals.otherOperatingNet)}{' '}
              {query.dataset.displayUnit}。调节关系为营业收入－三项成本费用合计＋其他营业损益净额＝营业利润。
            </>
          ) : (
            '营业收入减去上述三项成本费用后，与披露的营业利润一致。'
          )}
        </p>
      </section>
      <section id="pf-data" className="ar-report-section">
        <h2>原始指标与同比</h2>
        <FinancialTable query={query} />
      </section>
      <section id="pf-boundaries" className="ar-report-section">
        <h2>分析边界与后续核查</h2>
        <ul>
          {query.limitations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p>
          进一步判断变化原因，需对照年报管理层讨论、产品与地区分部、税项及会计政策说明。当前指标用于描述金额和比率变化。
        </p>
      </section>
      <section id="pf-source" className="ar-report-section">
        <h2>数据来源与计算口径</h2>
        <FinancialSources query={query} />
      </section>
      <footer className="ar-document-footer">
        <span>财小智 · 公开财报分析</span>
        <span>报告快照 {report.id}</span>
      </footer>
    </article>
  );
}

export function publicFinancialReportHtml(report: FinancialReport) {
  return (
    '<!doctype html>' +
    renderToStaticMarkup(
      <html lang="zh-CN">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>{report.title}</title>
          <style
            dangerouslySetInnerHTML={{
              __html: reportStyles + '\n' + publicStyles,
            }}
          />
        </head>
        <body className="pf-export">
          <ReportDocument report={report} />
        </body>
      </html>,
    )
  );
}

export function continuePublicReport(
  report: FinancialReport,
  workspace: Pick<WorkspaceAPI, 'closePanel' | 'send'>,
  viewportWidth: number,
) {
  if (viewportWidth < 1100) workspace.closePanel();
  workspace.send(
    `根据这份${financialEntity(report.snapshot.dataset)}${report.snapshot.period.label}报告继续分析利润变化`,
    [{ kind: 'report', id: report.id, title: report.title }],
  );
}

function GenerateReport({ query }: { query: FinancialQuery }) {
  const w = useWorkspace();
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true);
    try {
      const result = await api<{ report: FinancialReport }>(
        basePath + '/reports',
        {
          year: query.year,
          datasetId: query.dataset.id,
          datasetVersion: query.dataset.version,
        },
      );
      w.openPanel(publicReportPanel(result.report));
    } catch (error) {
      w.notify(
        error instanceof Error ? error.message : '报告生成失败，请重试。',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button icon="file" variant="primary" disabled={busy} onClick={generate}>
      {busy ? '正在生成…' : '生成报告'}
    </Button>
  );
}

function PublicReportList() {
  const w = useWorkspace();
  const { value, error, reload } = usePublicResource<{
    reports: FinancialReportListItem[];
  }>('/reports');
  if (!value) return <LoadState error={error} retry={reload} />;
  if (value.reports.length === 0)
    return (
      <div className="pf-feedback">
        暂无公开财报分析报告。选择年度后生成报告。
      </div>
    );
  return (
    <div className="as-reports-list">
      {value.reports.map((report) => (
        <button
          className="as-report-row"
          key={report.id}
          onClick={() =>
            w.openPanel({
              kind: 'report',
              id: report.id,
              title: report.title,
              data: { publicFinance: true, year: report.year },
            })
          }
        >
          <span className="result-icon">
            <Icon name="file" size={20} />
          </span>
          <span>
            <strong>{report.title}</strong>
            <small>
              {businessTime(report.createdAt)} · v{report.version} ·{' '}
              {report.sourceLabel ||
                report.shortName ||
                report.entity ||
                report.title}{' '}
              {report.currency || ''}
            </small>
          </span>
          <Badge tone="success">已生成</Badge>
          <Icon name="chevron" size={17} />
        </button>
      ))}
    </div>
  );
}

function FinancialOverview({ query }: { query: FinancialQuery }) {
  return (
    <>
      <FinancialMetrics query={query} />
      <FinancialFindings query={query} />
      <div className="pf-chart-grid">
        <TrendChart query={query} />
        <CostChart query={query} />
      </div>
      <FinancialTable query={query} />
      <details className="pf-source-details">
        <summary>数据来源与计算口径</summary>
        <FinancialSources query={query} />
      </details>
    </>
  );
}

export function PublicFinancialsPage() {
  const w = useWorkspace();
  const [year, setYear] = useState(2025);
  const [tab, setTab] = useState<'analysis' | 'reports'>('analysis');
  const {
    value: query,
    error,
    reload,
  } = usePublicResource<FinancialQuery>(`/query?year=${year}`);
  return (
    <div className="as-page ar-page pf-page">
      <div className="as-page-tabs">
        <div className="as-tabs">
          <button
            className={tab === 'analysis' ? 'active' : ''}
            onClick={() => setTab('analysis')}
          >
            财报分析
          </button>
          <button
            className={tab === 'reports' ? 'active' : ''}
            onClick={() => setTab('reports')}
          >
            分析报告
          </button>
        </div>
      </div>
      {tab === 'reports' ? (
        <PublicReportList />
      ) : (
        <>
          <div className="pf-toolbar">
            <div className="pf-entity">
              <h2>{query ? financialEntity(query.dataset) : '海康威视'}</h2>
              <Badge tone="blue">
                {query?.dataset.source.provider || '公开财报'}
              </Badge>
            </div>
            <div className="pf-actions">
              <select
                aria-label="财报年度"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                    {query ? financialPeriodLabel(query) : '年度'}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                icon="download"
                disabled={!query}
                onClick={() => query && downloadMetrics(query)}
              >
                下载指标
              </Button>
              {query && <GenerateReport query={query} />}
            </div>
          </div>
          {!query ? (
            <LoadState error={error} retry={reload} />
          ) : (
            <>
              <div className="pf-period">
                <span>
                  {query.period.start} 至 {query.period.end}
                </span>
                <span>
                  {financialCurrency(query.dataset)} · {query.dataset.label}
                </span>
              </div>
              <FinancialOverview query={query} />
              <div className="pf-footer-actions">
                <Button
                  icon="chat"
                  onClick={() =>
                    w.send(
                      `根据公开财报分析${financialEntity(query.dataset)}${query.period.label}的营收、成本与利润变化`,
                      [
                        {
                          kind: 'analysis',
                          id: query.dataset.id,
                          title: `${financialEntity(query.dataset)}${query.period.label}公开财报`,
                        },
                      ],
                    )
                  }
                >
                  在对话中分析
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function PublicFinancialsPanel({ panel }: { panel: PanelSpec }) {
  const year = Number(panel.data?.year ?? 2025);
  const snapshot = panel.data?.snapshot as FinancialQuery | undefined;
  const datasetId = panel.data?.datasetId as string | undefined;
  const {
    value: fetched,
    error,
    reload,
  } = usePublicResource<FinancialQuery>(
    snapshot ? null : `/query?year=${year}`,
  );
  const value = snapshot || fetched;
  if (!value) return <LoadState error={error} retry={reload} />;
  if (datasetId && value.dataset.id !== datasetId)
    return <HistoricalDatasetChanged />;
  return (
    <div className="pf-panel">
      <div className="pf-toolbar">
        <h2>
          {financialEntity(value.dataset)} {value.period.label}
        </h2>
        <GenerateReport query={value} />
      </div>
      <FinancialOverview query={value} />
    </div>
  );
}

function HistoricalDatasetChanged() {
  return (
    <div className="pf-feedback" role="status">
      此历史查询的数据源已切换，请重新查询或打开已保存报告。
    </div>
  );
}

export function PublicFinancialCard({
  year = 2025,
  snapshot,
  datasetId,
}: {
  year?: number;
  snapshot?: FinancialQuery;
  datasetId?: string;
}) {
  const w = useWorkspace();
  const {
    value: fetched,
    error,
    reload,
  } = usePublicResource<FinancialQuery>(
    snapshot ? null : `/query?year=${year}`,
  );
  const value = snapshot || fetched;
  if (!value) return <LoadState error={error} retry={reload} />;
  if (datasetId && value.dataset.id !== datasetId)
    return <HistoricalDatasetChanged />;
  return (
    <article className="pf-chat-card">
      <header>
        <strong>
          {financialEntity(value.dataset)} {value.period.label}
        </strong>
        <Badge tone="blue">{value.dataset.source.provider}</Badge>
      </header>
      <FinancialMetrics query={value} />
      <div className="pf-card-actions">
        <Button
          icon="chart"
          onClick={() =>
            w.openPanel({
              kind: 'analysis',
              title: `${financialEntity(value.dataset)}${value.period.label}分析`,
              data: {
                publicFinance: true,
                year: value.year,
                datasetId: value.dataset.id,
                snapshot: value,
              },
            })
          }
        >
          查看分析
        </Button>
        <GenerateReport query={value} />
      </div>
    </article>
  );
}

export function PublicFinancialReportPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace();
  const { value, error, reload } = usePublicResource<{
    report: FinancialReport;
  }>(`/reports/${encodeURIComponent(panel.id || '')}`);
  if (!value) return <LoadState error={error} retry={reload} />;
  const { report } = value;
  const chapters = [
    ['summary', '报告摘要'],
    ['trend', '经营趋势'],
    ['cost', '成本与费用'],
    ['data', '原始指标与同比'],
    ['boundaries', '分析边界与后续核查'],
    ['source', '数据来源与口径'],
  ];
  return (
    <div className="ar-report-workspace pf-report-workspace">
      <div className="ar-report-toolbar pf-report-toolbar">
        <span className="ar-report-state">
          已生成 · 服务端保存 · v{report.version}
        </span>
        <div className="pf-actions">
          <Button
            icon="download"
            onClick={() =>
              saveFile(
                `${report.title}.html`,
                publicFinancialReportHtml(report),
                'text/html;charset=utf-8',
              )
            }
          >
            下载 HTML
          </Button>
          <Button
            icon="download"
            variant="ghost"
            onClick={() => downloadMetrics(report.snapshot)}
          >
            下载指标
          </Button>
          <Button
            icon="chat"
            variant="primary"
            onClick={() => continuePublicReport(report, w, window.innerWidth)}
          >
            继续分析
          </Button>
        </div>
      </div>
      <div className="ar-reading-layout">
        <nav className="ar-toc" aria-label="财报报告目录">
          <span>报告目录</span>
          {chapters.map(([id, label]) => (
            <button
              key={id}
              onClick={(event) => {
                const container = event.currentTarget.closest(
                  '.pf-report-workspace',
                );
                container
                  ?.querySelector(`#pf-${id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <ReportDocument report={report} />
      </div>
    </div>
  );
}
