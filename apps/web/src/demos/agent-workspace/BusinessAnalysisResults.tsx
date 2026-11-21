import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BusinessBoardVisuals } from './BusinessBoardVisuals';
import {
  boardDateLabel,
  businessBoardQuery,
  type BoardView,
  type BusinessBoardSnapshot,
} from './business-board-model';
import { api } from './runtime-client';
import { businessTime } from './time-format';
import { Button, Icon } from './ui';
import { useWorkspace, type ResultCard } from './workspace';
import visualStyles from './business-board-visuals.css?raw';
import reportStyles from './business-analysis-results.css?raw';
import './business-analysis-results.css';

interface BoardReportSection {
  kind?: 'businessBoard';
  question: string;
  focus: BoardView;
  snapshot: BusinessBoardSnapshot;
}

interface OtherSourceSection {
  kind: 'publicFinance' | 'expenseCsv';
  question: string;
  snapshot: {
    title: string;
    source: string;
    scopeLabel: string;
    unit: string;
    metrics: { label: string; value: number; unit: string }[];
    breakdown: { name: string; value: number }[];
  };
}

interface BusinessReport {
  id: string;
  title: string;
  createdAt: string;
  sections: (BoardReportSection | OtherSourceSection)[];
}

function ScopeLine({ snapshot }: { snapshot: BusinessBoardSnapshot }) {
  return (
    <p className="ba-scope-line">
      <span>{snapshot.departmentLabel}</span>
      <span>{boardDateLabel(snapshot.scope)}</span>
    </p>
  );
}

export function BusinessAnalysisCard({ card }: { card: ResultCard }) {
  const w = useWorkspace();
  const snapshot: BusinessBoardSnapshot | undefined = card.data?.snapshot;
  if (!snapshot) return <p role="status">看板快照不可用，请重新查询。</p>;
  return (
    <section className="ba-answer" aria-label={card.title}>
      <header className="ba-answer-heading">
        <div>
          <h3>{snapshot.title}</h3>
          <ScopeLine snapshot={snapshot} />
        </div>
        <a
          href={'#analysis?' + businessBoardQuery(snapshot.scope)}
          onClick={(event) => {
            if (
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            w.closePanel();
            w.navigate(
              'analysis',
              'analysis?' + businessBoardQuery(snapshot.scope),
            );
          }}
        >
          打开看板 <Icon name="chevron" size={13} />
        </a>
      </header>
      <BusinessBoardVisuals
        snapshot={snapshot}
        view={card.data?.focus ?? 'overview'}
        compact
      />
      <footer className="ba-source">{snapshot.source}</footer>
    </section>
  );
}

function OtherSourceChart({ section }: { section: OtherSourceSection }) {
  const { metrics, breakdown, unit } = section.snapshot;
  const minimum = Math.min(0, ...breakdown.map((row) => row.value));
  const width =
    Math.max(0, ...breakdown.map((row) => row.value)) - minimum || 1;
  const asNumber = (value: number) =>
    value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return (
    <>
      <dl className="ba-source-metrics">
        {metrics.map((metric, index) => (
          <div key={index}>
            <dt>{metric.label}</dt>
            <dd>
              {asNumber(metric.value)} <small>{metric.unit}</small>
            </dd>
          </div>
        ))}
      </dl>
      {breakdown.length > 0 && (
        <figure className="ba-source-figure">
          <figcaption>
            {section.kind === 'expenseCsv' ? '分类费用小计' : '年度财务指标'}
            <small>单位 · {unit}</small>
          </figcaption>
          <ul>
            {breakdown.map(({ name, value }, index) => (
              <li key={index}>
                <span>{name}</span>
                <div aria-hidden="true">
                  <i
                    style={{
                      left:
                        ((Math.min(0, value) - minimum) / width) * 100 + '%',
                      width: (Math.abs(value) / width) * 100 + '%',
                    }}
                  />
                </div>
                <b>{asNumber(value)}</b>
              </li>
            ))}
          </ul>
        </figure>
      )}
    </>
  );
}

function ReportFigure({
  section,
  staticMode,
}: {
  section: BoardReportSection | OtherSourceSection;
  staticMode: boolean;
}) {
  const isBoard = 'focus' in section;
  const { snapshot } = section;
  return (
    <section className="ba-report-section">
      <h2>{snapshot.title}</h2>
      {isBoard ? (
        <>
          <ScopeLine snapshot={section.snapshot} />
          <BusinessBoardVisuals
            snapshot={section.snapshot}
            view={section.focus}
            compact={section.focus !== 'overview'}
            staticMode={staticMode}
            overviewDetails={
              section.snapshot.scope.system === 'expense'
                ? ['breakdown']
                : ['travel']
            }
          />
        </>
      ) : (
        <>
          <p className="ba-scope-line">{section.snapshot.scopeLabel}</p>
          <OtherSourceChart section={section} />
        </>
      )}
      <footer className="ba-section-foot">
        <span className="ba-source">{snapshot.source}</span>
        {section.question && (
          <details>
            <summary>查看提问</summary>
            <p>{section.question}</p>
          </details>
        )}
      </footer>
    </section>
  );
}

function ReportDocument({
  report,
  staticMode = false,
}: {
  report: BusinessReport;
  staticMode?: boolean;
}) {
  return (
    <article className="ba-report-paper">
      <header className="ba-report-cover">
        <div className="ba-report-byline">
          <Icon name="xiaozhi" size={20} />
          财小智
        </div>
        <h1>{report.title}</h1>
        <p>
          生成于 {businessTime(report.createdAt)} <span>·</span>{' '}
          {report.sections.length} 项分析
        </p>
      </header>
      {report.sections.map((section, index) => (
        <ReportFigure key={index} section={section} staticMode={staticMode} />
      ))}
    </article>
  );
}

export function businessReportHtml(report: BusinessReport) {
  const html = renderToStaticMarkup(
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{report.title}</title>
        <style
          dangerouslySetInnerHTML={{
            __html: visualStyles + '\n' + reportStyles,
          }}
        />
      </head>
      <body className="ba-export">
        <ReportDocument report={report} staticMode />
      </body>
    </html>,
  );
  return '<!doctype html>\n' + html;
}

function downloadReport(report: BusinessReport) {
  const url = URL.createObjectURL(
    new Blob([businessReportHtml(report)], { type: 'text/html;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = report.title + '.html';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BusinessReportPanel({ id }: { id?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [report, setReport] = useState<BusinessReport>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setReport(undefined);
    setError('');
    if (!id) {
      setError('缺少报告编号。');
      return;
    }
    api<{ report: BusinessReport }>(
      '/analytics/business/reports/' + encodeURIComponent(id),
    ).then(
      (response) => {
        if (active) setReport(response.report);
      },
      (failure) => {
        if (active) setError(failure.message);
      },
    );
    return () => {
      active = false;
    };
  }, [id, attempt]);
  if (error)
    return (
      <div className="ba-panel-status" role="alert">
        <p>{error}</p>
        <Button onClick={() => setAttempt((v) => v + 1)}>重新加载</Button>
      </div>
    );
  if (!report)
    return (
      <p className="ba-panel-status" role="status">
        正在读取报告…
      </p>
    );
  return (
    <div className="ba-report-reader">
      <div className="ba-report-tools">
        <span>已保存到会话</span>
        <Button icon="download" onClick={() => downloadReport(report)}>
          下载 HTML
        </Button>
      </div>
      <ReportDocument report={report} />
    </div>
  );
}
