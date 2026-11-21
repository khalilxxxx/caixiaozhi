import { useEffect, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardAnalysisTitle } from './business-board-handoff';
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
  metricId?: string;
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
  const view = card.data?.focus ?? 'overview';
  const title = boardAnalysisTitle(snapshot, view, card.data?.metricId);
  const boardLink =
    'analysis?' +
    businessBoardQuery(snapshot.scope) +
    (view === 'overview' ? '' : '&view=' + encodeURIComponent(view));
  return (
    <section className="ba-answer" aria-label={title}>
      <header className="ba-answer-heading">
        <div>
          <h3>{title}</h3>
          <ScopeLine snapshot={snapshot} />
        </div>
        <a
          href={'#' + boardLink}
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
            w.navigate('analysis', boardLink);
          }}
        >
          打开看板 <Icon name="chevron" size={13} />
        </a>
      </header>
      <BusinessBoardVisuals snapshot={snapshot} view={view} metricId={card.data?.metricId} compact />
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

type ReportItem = BoardReportSection | OtherSourceSection;

function sectionTitle(section: ReportItem) {
  return 'focus' in section
    ? boardAnalysisTitle(section.snapshot, section.focus, section.metricId)
    : section.snapshot.title;
}

function sectionScope(section: ReportItem) {
  return 'focus' in section
    ? section.snapshot.departmentLabel +
        ' · ' +
        boardDateLabel(section.snapshot.scope)
    : section.snapshot.scopeLabel;
}

function ReportFigure({
  section,
  anchor,
  staticMode,
}: {
  section: ReportItem;
  anchor: string;
  staticMode: boolean;
}) {
  const isBoard = 'focus' in section;
  const { snapshot } = section;
  return (
    <section className="ba-report-section" aria-labelledby={anchor}>
      <h2 id={anchor} tabIndex={-1}>
        {sectionTitle(section)}
      </h2>
      {isBoard ? (
        <>
          <ScopeLine snapshot={section.snapshot} />
          <BusinessBoardVisuals
            snapshot={section.snapshot}
            view={section.focus}
            metricId={section.metricId}
            compact={section.focus !== 'overview'}
            staticMode={staticMode}
            showComparison={section.focus === 'overview'}
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
  const titles = report.sections.map(sectionTitle);
  const scopes = new Set(report.sections.map(sectionScope));
  return (
    <article className="ba-report-paper">
      <header className="ba-report-cover">
        <div className="ba-report-byline">
          <Icon name="xiaozhi" size={20} />
          财小智
        </div>
        <h1>{report.title}</h1>
        {scopes.size === 1 && (
          <p className="ba-cover-scope">{sectionScope(report.sections[0]!)}</p>
        )}
        <p>
          生成于 {businessTime(report.createdAt)} <span>·</span>{' '}
          {report.sections.length} 项分析
        </p>
      </header>
      {report.sections.length > 1 && (
        <nav className="ba-report-index" aria-label="报告目录">
          <strong>报告目录</strong>
          <ol>
            {report.sections.map((section, index) => {
              const anchor = 'report-section-' + (index + 1);
              const title = titles[index]!;
              return (
                <li key={anchor}>
                  <a
                    href={'#' + anchor}
                    onClick={
                      staticMode
                        ? undefined
                        : (event) => {
                            event.preventDefault();
                            const heading = event.currentTarget
                              .closest('article')
                              ?.querySelector<HTMLElement>('#' + anchor);
                            heading?.focus({ preventScroll: true });
                            heading?.scrollIntoView({
                              block: 'start',
                              behavior: 'instant',
                            });
                          }
                    }
                  >
                    {title}
                    {titles.indexOf(title) !== titles.lastIndexOf(title) && (
                      <small>{sectionScope(section)}</small>
                    )}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {report.sections.map((section, index) => (
        <ReportFigure
          key={index}
          section={section}
          staticMode={staticMode}
          anchor={'report-section-' + (index + 1)}
        />
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
  const w = useWorkspace();
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
        <div className="ba-report-actions">
          <Button
            icon="chat"
            onClick={() => {
              w.attach({
                kind: 'report',
                id: report.id,
                title: report.title,
                followupId: crypto.randomUUID(),
              });
              requestAnimationFrame(() =>
                document.getElementById('message-input')?.focus(),
              );
            }}
          >
            引用报告追问
          </Button>
          <Button icon="download" onClick={() => downloadReport(report)}>
            下载 HTML
          </Button>
        </div>
      </div>
      <ReportDocument report={report} />
    </div>
  );
}
