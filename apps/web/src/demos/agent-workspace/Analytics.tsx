import { businessTime } from './time-format';
import { useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSlice, useWorkspace, type PanelSpec } from './workspace';
import { Badge, Button, Field, Icon } from './ui';
import {
  DEFAULT_ANALYSIS_SCOPE,
  normalizeAnalysisScope,
  analysisScopeLabel,
  analysisRows,
  analysisAmount,
  analysisSummary,
  departments,
  categories,
  wan,
  yuan,
  buildAnalysisModel,
  type AnalysisScope,
  type AnalysisRow,
} from './analytics-model';
import reportStyles from './analytics-report.css?raw';
import './analytics-skills.css';
import './analytics-report.css';
export { BusinessBoardPage as AnalysisPage } from './BusinessBoardPage';
export {
  DEFAULT_ANALYSIS_SCOPE,
  normalizeAnalysisScope,
  analysisScopeLabel,
  analysisRows,
  analysisAmount,
  analysisSummary,
  parseAnalysisScope,
} from './analytics-model';
export type { AnalysisScope } from './analytics-model';

type Model = ReturnType<typeof buildAnalysisModel>;
type Series = Model['categories'];
interface Report {
  id: string;
  scope: AnalysisScope;
  title: string;
  summary: string;
  actions: string;
  created: string;
  status: 'preparing' | 'ready';
  version: number;
}
type ReportDraft = Pick<Report, 'title' | 'summary' | 'actions'>;
interface AnalysisState {
  scope: AnalysisScope;
  queries: { id: string; scope: AnalysisScope }[];
  reports: Report[];
  reportDrafts?: Record<string, ReportDraft>;
}
const initialAnalysis: AnalysisState = {
  scope: DEFAULT_ANALYSIS_SCOPE,
  queries: [],
  reports: [],
};
const palette = ['#3974df', '#47a9a1', '#e5ad4f', '#8b86bd'];
function download(
  name: string,
  content: string,
  type = 'text/plain;charset=utf-8',
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportRows(scope: AnalysisScope, records: AnalysisRow[]) {
  const cells = [
    ['汇总编号', '部门', '费用类型', '记录日期', '金额（元）', '统计口径'],
    ...analysisRows(scope, records).map((r) => [
      r.id,
      r.dept + '部',
      r.type,
      r.date,
      r.amount,
      '审批已完成的报销费用；人民币含税；非付款额',
    ]),
  ];
  download(
    `费用明细-${scope.month}-${scope.dept}.csv`,
    '\ufeff' +
      cells
        .map((row) =>
          row.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(','),
        )
        .join('\r\n'),
    'text/csv;charset=utf-8',
  );
}
function scopePanel(scope: AnalysisScope, tab = 'overview'): PanelSpec {
  return {
    kind: 'analysis',
    title: analysisScopeLabel(scope),
    data: { scope: { ...scope }, tab },
  };
}
function reportPanel(scope: AnalysisScope): PanelSpec {
  return {
    kind: 'report',
    title: '生成费用分析报告',
    data: { scope: { ...scope } },
  };
}
function ScopeFilters({
  scope,
  onChange,
}: {
  scope: AnalysisScope;
  onChange: (scope: AnalysisScope) => void;
}) {
  return (
    <div className="as-filters">
      <select
        aria-label="统计月份"
        value={scope.month}
        onChange={(e) =>
          onChange({ ...scope, month: e.target.value as '09' | '10' })
        }
      >
        <option value="10">2026年10月</option>
        <option value="09">2026年9月</option>
      </select>
      <select
        aria-label="统计部门"
        value={scope.dept}
        onChange={(e) => onChange({ ...scope, dept: e.target.value })}
      >
        <option value="全部部门">全集团</option>
        {departments.map((d) => (
          <option key={d} value={d}>
            {d}部
          </option>
        ))}
      </select>
      <select
        aria-label="费用类型"
        value={scope.type || ''}
        onChange={(e) => onChange({ ...scope, type: e.target.value || null })}
      >
        <option value="">全部费用</option>
        {categories.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
    </div>
  );
}
function Metrics({ model }: { model: Model }) {
  const c = model.comparison;
  return (
    <div className="ar-metrics">
      <div>
        <span>已完成报销费用</span>
        <strong>
          {wan(model.total)}
          <small>万元</small>
        </strong>
        <small>{model.count} 条汇总记录</small>
      </div>
      <div>
        <span>环比变化</span>
        <strong>
          {c
            ? `${c.pct === null ? '—' : (c.pct > 0 ? '+' : '') + c.pct.toFixed(1)}`
            : '—'}
          {c?.pct !== null && c && <small>%</small>}
        </strong>
        <small>
          {c
            ? `较9月${c.delta >= 0 ? '增加' : '减少'} ${wan(Math.abs(c.delta))} 万元${c.pct === null ? ' · 基期为0' : ''}`
            : '未提供8月数据'}
        </small>
      </div>
      <div>
        <span>预算执行率</span>
        <strong>
          {model.budget ? ((model.total / model.budget) * 100).toFixed(1) : '—'}
          {model.budget && <small>%</small>}
        </strong>
        <small>
          {model.budget
            ? `预算 ${wan(model.budget)} 万元 · 余额 ${wan(model.budget - model.total)} 万元`
            : '当前范围未提供预算'}
        </small>
      </div>
    </div>
  );
}
function Findings({ model, summary }: { model: Model; summary?: string }) {
  return (
    <div className="ar-summary">
      <p className="ar-summary-lead">{summary || model.summary}</p>
      <ul>
        {model.findings.map((f) => (
          <li key={f.title}>
            <strong>{f.title}</strong>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
function Insight({ children }: { children: ReactNode }) {
  return (
    <p className="ar-insight">
      <Icon name="spark" size={16} />
      <span>{children}</span>
    </p>
  );
}
function Figure({
  title,
  meta,
  children,
  insight,
}: {
  title: string;
  meta: string;
  children: ReactNode;
  insight: string;
}) {
  return (
    <section className="ar-figure">
      <div className="ar-figure-heading">
        <h3>{title}</h3>
        <span>{meta}</span>
      </div>
      {children}
      <Insight>{insight}</Insight>
    </section>
  );
}
function Distribution({
  model,
  onDrill,
}: {
  model: Model;
  onDrill?: (scope: AnalysisScope) => void;
}) {
  let offset = 0;
  return (
    <div className="ar-distribution">
      <svg
        viewBox="0 0 220 220"
        role="img"
        aria-label={`费用构成，总计${wan(model.total)}万元`}
      >
        <circle
          cx="110"
          cy="110"
          r="78"
          fill="none"
          stroke="#edf1f7"
          strokeWidth="24"
        />
        {model.categories.map((v, i) => {
          const start = offset;
          offset += v.share;
          return (
            <circle
              key={v.name}
              cx="110"
              cy="110"
              r="78"
              pathLength="100"
              fill="none"
              stroke={palette[i % 4]}
              strokeWidth="24"
              strokeDasharray={`${v.share} ${100 - v.share}`}
              strokeDashoffset={-start}
              transform="rotate(-90 110 110)"
            >
              <title>
                {v.name}：{wan(v.value)}万元，占比{v.share.toFixed(1)}%
              </title>
            </circle>
          );
        })}
        <text x="110" y="103" textAnchor="middle" className="ar-donut-label">
          费用合计
        </text>
        <text x="110" y="134" textAnchor="middle" className="ar-donut-value">
          {wan(model.total)}
          <tspan className="ar-donut-unit"> 万元</tspan>
        </text>
      </svg>
      <div className="ar-legend-list">
        {model.categories.map((v, i) => {
          const content = (
            <>
              <i style={{ background: palette[i % 4] }} />
              <span>{v.name}</span>
              <strong>
                {wan(v.value)}
                <small>万元</small>
              </strong>
              <em>{v.share.toFixed(1)}%</em>
            </>
          );
          return onDrill ? (
            <button
              key={v.name}
              onClick={() => onDrill({ ...model.scope, type: v.name })}
              aria-label={`查看${v.name}明细`}
            >
              {content}
              <Icon name="chevron" size={13} />
            </button>
          ) : (
            <div key={v.name}>{content}</div>
          );
        })}
      </div>
    </div>
  );
}
function ComparisonChart({ model }: { model: Model }) {
  const values = model.categories;
  const max = Math.max(
    ...values.flatMap((v) => [v.value, v.previous || 0]),
    10000,
  );
  const ceiling = Math.ceil(max / 10000) * 10000;
  const height = 172;
  const group = 360 / Math.max(values.length, 1);
  return (
    <div className="ar-comparison">
      <div className="ar-chart-key">
        <span>
          <i style={{ background: '#cedcf3' }} />
          9月
        </span>
        <span>
          <i style={{ background: palette[0] }} />
          10月
        </span>
      </div>
      <svg
        viewBox="0 0 440 245"
        role="img"
        aria-label="9月与10月各类费用比较，单位万元"
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const y = 195 - (i * height) / 4;
          return (
            <g key={i}>
              <line
                x1="48"
                y1={y}
                x2="426"
                y2={y}
                stroke="#e8edf5"
                strokeDasharray={i ? '3 4' : undefined}
              />
              <text x="38" y={y + 4} textAnchor="end" className="ar-axis-text">
                {wan((ceiling * i) / 4)}
              </text>
            </g>
          );
        })}
        {values.map((v, i) => {
          const x = 55 + i * group + group / 2;
          const width = Math.min(27, group / 3);
          return (
            <g key={v.name}>
              <rect
                x={x - width - 3}
                y={195 - ((v.previous || 0) / ceiling) * height}
                width={width}
                height={((v.previous || 0) / ceiling) * height}
                rx="3"
                fill="#cedcf3"
              >
                <title>
                  9月{v.name}：{wan(v.previous || 0)}万元
                </title>
              </rect>
              <rect
                x={x + 3}
                y={195 - (v.value / ceiling) * height}
                width={width}
                height={(v.value / ceiling) * height}
                rx="3"
                fill={palette[0]}
              >
                <title>
                  10月{v.name}：{wan(v.value)}万元
                </title>
              </rect>
              <text
                x={x + 3 + width / 2}
                y={185 - (v.value / ceiling) * height}
                textAnchor="middle"
                className="ar-value-text"
              >
                {wan(v.value)}
              </text>
              <text x={x} y="222" textAnchor="middle" className="ar-axis-text">
                {v.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
function RankChart({
  model,
  onDrill,
}: {
  model: Model;
  onDrill?: (scope: AnalysisScope) => void;
}) {
  const values = [...model.departments].sort((a, b) => b.value - a.value);
  const max = Math.max(...values.map((v) => v.value), 1);
  return (
    <div className="ar-ranking">
      {values.map((v, i) => {
        const body = (
          <>
            <span>{v.name}部</span>
            <span className="ar-rank-track">
              <i
                style={{
                  width: `${(v.value / max) * 100}%`,
                  background: i === 0 ? palette[0] : '#9db9ed',
                }}
              />
            </span>
            <strong>{wan(v.value)}</strong>
            <small>{v.share.toFixed(1)}%</small>
          </>
        );
        return onDrill ? (
          <button
            key={v.name}
            onClick={() => onDrill({ ...model.scope, dept: v.name })}
            aria-label={`查看${v.name}部明细`}
          >
            {body}
          </button>
        ) : (
          <div key={v.name}>{body}</div>
        );
      })}
      <div className="ar-rank-scale">
        <span>0</span>
        <span>{wan(max / 2)}</span>
        <span>{wan(max)} 万元</span>
      </div>
    </div>
  );
}
function Changes({ values }: { values: Series }) {
  const max = Math.max(...values.map((v) => Math.abs(v.delta || 0)), 1);
  return (
    <div className="ar-changes">
      {values.map((v) => (
        <div key={v.name}>
          <span>{v.name}</span>
          <div className="ar-change-track">
            <i
              className={v.delta !== null && v.delta < 0 ? 'negative' : ''}
              style={{ width: `${(Math.abs(v.delta || 0) / max) * 45}%` }}
            />
          </div>
          <strong>
            {v.delta === null
              ? '—'
              : `${v.delta > 0 ? '+' : ''}${wan(v.delta)}`}
          </strong>
        </div>
      ))}
      <p>费用增减额 · 万元</p>
    </div>
  );
}
function DataTable({
  scope,
  records,
}: {
  scope: AnalysisScope;
  records: AnalysisRow[];
}) {
  const rows = analysisRows(scope, records);
  return (
    <div className="as-table-wrap">
      <table className="as-table ar-data-table">
        <caption>{analysisScopeLabel(scope)} · 费用汇总明细</caption>
        <thead>
          <tr>
            <th>汇总编号</th>
            <th>部门 / 类型</th>
            <th>记录日期</th>
            <th className="number">金额（元）</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>
                  {r.dept}部 · {r.type}
                </td>
                <td>{r.date}</td>
                <td className="number">{yuan(r.amount)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4}>当前范围暂无报销记录</td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>{rows.length}条汇总记录 · 合计</td>
            <td className="number">{yuan(analysisAmount(scope, records))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
function Basis({ scope }: { scope: AnalysisScope }) {
  return (
    <dl className="as-basis ar-basis">
      <dt>统计范围</dt>
      <dd>{analysisScopeLabel(scope)}</dd>
      <dt>金额定义</dt>
      <dd>审批已完成的报销费用，人民币、含税；不代表付款金额。</dd>
      <dt>时间口径</dt>
      <dd>按审批完成日归属月份，整月比较。</dd>
      <dt>比较期</dt>
      <dd>
        {scope.month === '10'
          ? '9月，同部门、同费用类型。'
          : '未提供8月数据，不计算环比。'}
      </dd>
      <dt>数据来源</dt>
      <dd>本地模拟业务数据 · 月份、部门、费用类型汇总</dd>
      <dt>数据快照</dt>
      <dd>2026-11-02 08:00</dd>
      <dt>预算范围</dt>
      <dd>仅10月集团提供同口径预算60.00万元；其他范围未提供。</dd>
      <dt>未覆盖</dt>
      <dd>付款状态、费用发生日、业务量与去年同期。</dd>
    </dl>
  );
}
function Overview({
  scope,
  onDrill,
  summary,
  records,
}: {
  records: AnalysisRow[];
  scope: AnalysisScope;
  onDrill: (scope: AnalysisScope) => void;
  summary?: string;
}) {
  const model = buildAnalysisModel(scope, records);
  return (
    <div className="ar-overview">
      <Metrics model={model} />
      <section className="ar-overview-summary">
        <div className="ar-section-heading">
          <Icon name="spark" size={18} />
          <h3>分析概述</h3>
        </div>
        <Findings model={model} summary={summary} />
      </section>
      <div className="ar-chart-grid">
        <Figure
          title="费用构成"
          meta="金额 / 占比"
          insight={model.insights.structure}
        >
          <Distribution model={model} onDrill={onDrill} />
        </Figure>
        <Figure
          title={model.comparison ? '月度费用比较' : '部门费用分布'}
          meta="单位：万元"
          insight={
            model.comparison
              ? model.insights.comparison
              : model.insights.departments
          }
        >
          {model.comparison ? (
            <ComparisonChart model={model} />
          ) : (
            <RankChart model={model} onDrill={onDrill} />
          )}
        </Figure>
      </div>
    </div>
  );
}
export function AnalysisCard({ scope }: { scope?: Partial<AnalysisScope> }) {
  const w = useWorkspace(),
    model = buildAnalysisModel(
      normalizeAnalysisScope(scope),
      w.state.data.analysisRecords ?? [],
    );
  return (
    <article className="aw-analysis-card ar-chat-card">
      <div className="as-card-top">
        <strong>费用分析</strong>
        <span>{analysisScopeLabel(model.scope)}</span>
      </div>
      <div className="ar-card-metrics">
        <div>
          <span>已完成报销费用</span>
          <strong>
            {wan(model.total)}
            <small>万元</small>
          </strong>
        </div>
        <div>
          <span>环比变化</span>
          <strong>
            {model.comparison?.pct != null
              ? `${model.comparison.pct > 0 ? '+' : ''}${model.comparison.pct.toFixed(1)}%`
              : '—'}
          </strong>
        </div>
      </div>
      <p>{model.summary}</p>
      <div className="ar-card-composition" aria-label="费用构成">
        {model.categories.map((v, i) => (
          <span
            key={v.name}
            style={{ width: `${v.share}%`, background: palette[i % 4] }}
            title={`${v.name} ${v.share.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="as-card-actions">
        <Button
          variant="primary"
          onClick={() => w.openPanel(scopePanel(model.scope))}
        >
          查看分析
        </Button>
        <Button
          variant="ghost"
          onClick={() => w.openPanel(reportPanel(model.scope))}
        >
          生成报告
        </Button>
        <button
          className="as-link"
          onClick={() => w.openPanel(scopePanel(model.scope, 'basis'))}
        >
          口径与来源
        </button>
      </div>
    </article>
  );
}
export function AnalysisPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [scope, setScope] = useState(normalizeAnalysisScope(panel.data?.scope)),
    [tab, setTab] = useState(String(panel.data?.tab || 'overview'));
  const records = (w.state.data.analysisRecords ?? []) as AnalysisRow[];
  return (
    <div className="as-panel ar-analysis-panel">
      <div className="as-tabs">
        {[
          ['overview', '概述'],
          ['details', '明细'],
          ['basis', '口径与来源'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'basis' ? (
        <Basis scope={scope} />
      ) : tab === 'details' ? (
        <>
          <div className="as-detail-heading">
            <span>{analysisScopeLabel(scope)}</span>
            <Button
              icon="download"
              variant="ghost"
              onClick={() => exportRows(scope, records)}
            >
              下载
            </Button>
          </div>
          <DataTable records={records} scope={scope} />
        </>
      ) : (
        <Overview
          records={records}
          scope={scope}
          onDrill={(s) => {
            setScope(s);
            setTab('details');
          }}
        />
      )}
      <div className="as-scope-editor">
        <ScopeFilters scope={scope} onChange={setScope} />
        <div className="as-actions">
          <Button
            onClick={() => {
              const fixed = { ...scope };
              w.message(analysisSummary(fixed, records), [
                { kind: 'analysis', title: '费用分析', data: { scope: fixed } },
              ]);
              w.closePanel();
              w.navigate('chat');
            }}
          >
            按此范围生成新结果
          </Button>
          <Button
            variant="primary"
            onClick={() => w.openPanel(reportPanel(scope))}
          >
            生成报告
          </Button>
        </div>
      </div>
    </div>
  );
}
const sections = [
  ['summary', '报告摘要'],
  ['structure', '费用构成'],
  ['comparison', '月度比较'],
  ['departments', '部门分析'],
  ['actions', '核查与建议'],
  ['source', '来源与口径'],
];
function ReportDocument({
  report,
  onDrill,
  standalone = false,
  records,
}: {
  records: AnalysisRow[];
  report: Report;
  onDrill?: (s: AnalysisScope) => void;
  standalone?: boolean;
}) {
  const model = buildAnalysisModel(report.scope, records);
  return (
    <article className="ar-document">
      <header className="ar-document-header">
        <h1>{report.title}</h1>
        <p>
          {analysisScopeLabel(report.scope)}
          <span>人民币 · 含税 · 按审批完成日</span>
        </p>
        <div className="ar-document-meta">
          <span>数据快照 2026-11-02 08:00</span>
          <span>v{report.version} · 本地模拟业务数据</span>
        </div>
      </header>
      <section id="ar-summary" className="ar-report-section">
        <h2>报告摘要</h2>
        <Metrics model={model} />
        <Findings model={model} summary={report.summary} />
      </section>
      <section id="ar-structure" className="ar-report-section">
        <h2>费用构成</h2>
        <Figure
          title="各类费用占比"
          meta="单位：万元"
          insight={model.insights.structure}
        >
          <Distribution model={model} onDrill={onDrill} />
        </Figure>
      </section>
      <section id="ar-comparison" className="ar-report-section">
        <h2>月度比较</h2>
        {model.comparison ? (
          <>
            <Figure
              title="各类费用月度对比"
              meta="2026年9月 / 10月 · 万元"
              insight={model.insights.comparison}
            >
              <ComparisonChart model={model} />
            </Figure>
            <div className="ar-contribution">
              <h3>费用变化贡献</h3>
              <Changes values={model.categories} />
            </div>
          </>
        ) : (
          <p className="ar-unavailable">
            未提供8月数据，本期不计算环比。当前费用合计 {wan(model.total)}{' '}
            万元。
          </p>
        )}
      </section>
      <section id="ar-departments" className="ar-report-section">
        <h2>部门分析</h2>
        <Figure
          title={
            report.scope.dept === '全部部门'
              ? '部门费用排名'
              : `${report.scope.dept}部费用`
          }
          meta="金额（万元） / 占比"
          insight={model.insights.departments}
        >
          <RankChart model={model} onDrill={onDrill} />
        </Figure>
      </section>
      <section id="ar-actions" className="ar-report-section">
        <h2>核查与建议</h2>
        <p className="ar-action-lead">{report.actions}</p>
        <ul className="ar-recommendations">
          {model.recommendations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        <p className="ar-limit">
          金额变化不等于业务原因。当前未提供费用发生日、业务量与去年同期数据。
        </p>
      </section>
      <section id="ar-source" className="ar-report-section">
        <h2>来源与口径</h2>
        <Basis scope={report.scope} />
      </section>
      {standalone && (
        <section className="ar-report-section">
          <h2>费用汇总明细</h2>
          <DataTable records={records} scope={report.scope} />
        </section>
      )}
      <footer className="ar-document-footer">
        <span>财小智 · 费用分析报告</span>
        <span>{businessTime(report.created)}</span>
      </footer>
    </article>
  );
}
function exportReport(report: Report, records: AnalysisRow[]) {
  const html = renderToStaticMarkup(
    <ReportDocument report={report} records={records} standalone />,
  );
  const safeTitle = report.title.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
  download(
    `${report.title.replace(/[\\/:*?"<>|]/g, '-')}.html`,
    `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>${reportStyles}</style></head><body class="ar-export">${html}</body></html>`,
    'text/html;charset=utf-8',
  );
}
export function ReportPanel({ panel }: { panel: PanelSpec }) {
  const w = useWorkspace(),
    [data, setData] = useSlice<AnalysisState>(
      'analysisWorkspace',
      initialAnalysis,
    ),
    [editing, setEditing] = useState(
      Boolean(data.reportDrafts?.[panel.id || '']),
    ),
    [note, setNote] = useState(''),
    [tab, setTab] = useState<'report' | 'overview' | 'details'>('report'),
    [drill, setDrill] = useState<AnalysisScope | null>(null),
    [activeSection, setActiveSection] = useState('summary');
  const records = (w.state.data.analysisRecords ?? []) as AnalysisRow[];
  const report = data.reports.find((r) => r.id === panel.id),
    draft = data.reportDrafts?.[panel.id || ''] || null;
  const setDraft = (next: ReportDraft | null) => {
    if (!panel.id) return;
    setData((p) => {
      const reportDrafts = { ...p.reportDrafts };
      if (next)
        reportDrafts[panel.id!] = {
          title: next.title,
          summary: next.summary,
          actions: next.actions,
        };
      else delete reportDrafts[panel.id!];
      return { ...p, reportDrafts };
    });
  };
  const scope = normalizeAnalysisScope(report?.scope || panel.data?.scope),
    model = buildAnalysisModel(scope, records);
  const create = async () => {
    const id = 'report-' + crypto.randomUUID();
    const item: Report = {
      id,
      scope: { ...scope },
      title: `${Number(scope.month)}月${scope.dept === '全部部门' ? '集团' : scope.dept + '部'}${scope.type || '费用'}分析`,
      summary: model.summary,
      actions:
        model.recommendations[0] ||
        '当前范围暂无报销记录，可调整统计范围后重新分析。',
      created: new Date().toLocaleString('zh-CN', {
        hour12: false,
        timeZone: 'Asia/Shanghai',
      }),
      status: 'ready',
      version: 1,
    };
    setData((p) => ({ ...p, reports: [item, ...p.reports] }));
    w.openPanel({
      kind: 'report',
      title: item.title,
      id,
      data: { scope: item.scope },
    });
    try {
      await w.flush();
      w.notify('报告已生成并保存');
    } catch (error) {
      w.notify(error instanceof Error ? error.message : '报告保存失败');
    }
  };
  if (!report)
    return (
      <div className="ar-plan">
        <div className="as-plan-scope">
          <Icon name="file" size={29} />
          <strong>{analysisScopeLabel(scope)}</strong>
          <Badge>本地模拟业务数据</Badge>
        </div>
        <h2>费用分析报告</h2>
        <Metrics model={model} />
        <div className="ar-plan-columns">
          <section>
            <h3>报告内容</h3>
            <ul>
              {sections.map(([, label]) => (
                <li key={label}>
                  <Icon name="check" size={15} />
                  {label}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>统计范围</h3>
            <Basis scope={scope} />
          </section>
        </div>
        <div className="as-panel-footer">
          <Button variant="primary" icon="spark" onClick={create}>
            开始整理报告
          </Button>
        </div>
      </div>
    );
  const current = draft || report;
  const onDrill = (s: AnalysisScope) => {
    setDrill(s);
    setTab('details');
  };
  const save = async () => {
    if (!current.title.trim() || !current.summary.trim()) {
      setNote('请保留报告标题与分析摘要。');
      return;
    }
    setData((p) => {
      const drafts = { ...p.reportDrafts };
      delete drafts[report.id];
      return {
        ...p,
        reports: p.reports.map((r) =>
          r.id === report.id
            ? {
                ...r,
                title: current.title,
                summary: current.summary,
                actions: current.actions,
                scope: r.scope,
                version: r.version + 1,
              }
            : r,
        ),
        reportDrafts: drafts,
      };
    });
    setEditing(false);
    setNote('');
    w.openPanel({
      kind: 'report',
      id: report.id,
      title: current.title,
      data: { scope: report.scope },
    });
    try {
      await w.flush();
      w.notify('报告内容已保存，数据范围保持不变');
    } catch (error) {
      setNote(error instanceof Error ? error.message : '报告保存失败');
    }
  };
  return (
    <div className="ar-report-workspace">
      <div className="ar-report-toolbar">
        <div className="ar-report-state">
          <Badge tone="success">已完成</Badge>
          <span>
            v{report.version}
            {editing ? ' · 编辑草稿已保留' : ''}
          </span>
        </div>
        <div className="as-actions">
          <Button
            icon="edit"
            variant="ghost"
            onClick={() => {
              if (editing) {
                setDraft(null);
                setEditing(false);
                setNote('');
              } else {
                setDraft({
                  title: report.title,
                  summary: report.summary,
                  actions: report.actions,
                });
                setEditing(true);
              }
            }}
          >
            {editing ? '取消编辑' : '编辑摘要'}
          </Button>
          {editing ? (
            <Button variant="primary" onClick={save}>
              保存内容
            </Button>
          ) : (
            <Button
              icon="download"
              onClick={() => exportReport(report, records)}
            >
              下载报告
            </Button>
          )}
        </div>
      </div>
      {editing ? (
        <div className="ar-edit">
          <Field label="报告标题">
            <input
              aria-label="报告标题"
              value={current.title}
              onChange={(e) => setDraft({ ...current, title: e.target.value })}
            />
          </Field>
          <Field label="分析摘要">
            <textarea
              aria-label="摘要"
              rows={6}
              value={current.summary}
              onChange={(e) =>
                setDraft({ ...current, summary: e.target.value })
              }
            />
          </Field>
          <Field label="行动建议">
            <textarea
              aria-label="建议"
              rows={4}
              value={current.actions}
              onChange={(e) =>
                setDraft({ ...current, actions: e.target.value })
              }
            />
          </Field>
          {note && <p role="alert">{note}</p>}
          <p>统计范围：{analysisScopeLabel(scope)}</p>
          <Button variant="primary" onClick={save}>
            保存内容
          </Button>
        </div>
      ) : (
        <>
          <div className="as-tabs ar-report-tabs">
            {[
              ['overview', '概述'],
              ['report', '完整报告'],
              ['details', '明细数据'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? 'active' : ''}
                onClick={() => {
                  setTab(key as typeof tab);
                  setDrill(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'overview' ? (
            <Overview
              records={records}
              scope={scope}
              summary={report.summary}
              onDrill={onDrill}
            />
          ) : tab === 'details' ? (
            <div className="ar-report-details">
              <div className="as-detail-heading">
                <span>{analysisScopeLabel(drill || scope)}</span>
                <div className="as-actions">
                  {drill && (
                    <Button
                      icon="back"
                      variant="ghost"
                      onClick={() => {
                        setTab('report');
                        setDrill(null);
                      }}
                    >
                      返回报告
                    </Button>
                  )}
                  <Button
                    icon="download"
                    onClick={() => exportRows(drill || scope, records)}
                  >
                    下载明细
                  </Button>
                </div>
              </div>
              <DataTable records={records} scope={drill || scope} />
            </div>
          ) : (
            <div className="ar-reading-layout">
              <nav className="ar-toc" aria-label="报告目录">
                <span>报告目录</span>
                {sections.map(([id, label]) => (
                  <button
                    key={id}
                    className={activeSection === id ? 'active' : ''}
                    onClick={() => {
                      setActiveSection(id!);
                      document.getElementById(`ar-${id}`)?.scrollIntoView({
                        behavior: window.matchMedia(
                          '(prefers-reduced-motion: reduce)',
                        ).matches
                          ? 'instant'
                          : 'smooth',
                        block: 'start',
                      });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <ReportDocument
                report={report}
                records={records}
                onDrill={onDrill}
              />
            </div>
          )}
        </>
      )}
      <div className="ar-report-footer">
        <span>{analysisScopeLabel(scope)} · 本地模拟业务数据</span>
        <Button
          icon="chat"
          variant="primary"
          onClick={() => {
            w.attach({
              kind: 'report',
              id: report.id,
              title: report.title,
              version: `v${report.version}`,
            });
            w.attach({
              kind: 'analysis',
              id: JSON.stringify(scope),
              title: analysisScopeLabel(scope),
            });
            w.closePanel();
            w.navigate('chat');
          }}
        >
          围绕报告继续对话
        </Button>
      </div>
    </div>
  );
}
