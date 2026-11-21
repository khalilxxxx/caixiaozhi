import { useId, useState, type HTMLAttributes, type ReactNode } from 'react';
import { Icon } from './ui';
import {
  boardDateLabel,
  type BoardView,
  type BusinessBoardSnapshot,
} from './business-board-model';
import './business-board-visuals.css';

const number = (value: number) =>
  value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const amount = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
}).format;
const palette = [
  '#246b91',
  '#4aa59e',
  '#e1a05f',
  '#9594ca',
  '#6095c4',
  '#ba7285',
];
const metricIcons: Record<string, string> = {
  expenseAmount: 'wallet',
  travelAmount: 'wallet',
  claimCount: 'file',
  tripCount: 'plane',
  travelerCount: 'brief',
  tripDays: 'tasks',
};

function ChartFrame({
  title,
  meta,
  view,
  children,
}: {
  title: string;
  meta?: ReactNode;
  view?: BoardView;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="bb-figure"
      data-board-view={view}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="bb-figure-heading">
        <h3 id={titleId}>{title}</h3>
        {meta && <span>{meta}</span>}
      </header>
      {children}
    </section>
  );
}

function metricChange(current: number, previous: number) {
  if (current === previous) return '持平';
  if (previous === 0) return '本期新增';
  const percent = Math.abs((current - previous) / previous) * 100;
  const value = percent < 0.1 ? '<0.1' : number(Number(percent.toFixed(1)));
  return `${current > previous ? '增加' : '减少'} ${value}%`;
}

function Metrics({
  snapshot,
  compare,
  selected,
}: {
  snapshot: BusinessBoardSnapshot;
  compare: boolean;
  selected?: BusinessBoardSnapshot['metrics'][number];
}) {
  const comparison = compare ? snapshot.comparison : undefined;
  const comparisonLabels = {
    previousMonth: '上个自然月',
    monthToDate: '上月同期',
    previousPeriod: `前 ${comparison?.days} 天`,
  };
  return (
    <>
      {comparison && (
        <p className="bb-comparison-period">
          对比{comparisonLabels[comparison.kind]}{' '}
          <span>{boardDateLabel(comparison)}</span>
        </p>
      )}
      {comparison === null && (
        <p className="bb-comparison-period">
          前期超出台账覆盖期，暂无前期对比。
        </p>
      )}
      <dl className={selected ? 'bb-metrics bb-single-metric' : 'bb-metrics'}>
        {(selected ? [selected] : snapshot.metrics).map((metric) => {
          const previous = comparison?.values[metric.id];
          return (
            <div key={metric.id}>
              <dt>
                <Icon name={metricIcons[metric.id] || 'chart'} size={15} />
                {metric.label}
              </dt>
              <dd>
                {metric.unit === '元'
                  ? amount(metric.value)
                  : number(metric.value)}
                <small>{metric.unit}</small>
              </dd>
              {previous !== undefined && (
                <dd className="bb-metric-comparison">
                  <span>
                    前期{' '}
                    {metric.unit === '元' ? amount(previous) : number(previous)}{' '}
                    {metric.unit}
                  </span>
                  <b>{metricChange(metric.value, previous)}</b>
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </>
  );
}

function niceStep(max: number, integer: boolean) {
  const rough = Math.max(integer ? 1 : 0.01, max / 3);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step =
    ([1, 2, 2.5, 5, 10].find((multiple) => multiple * power >= rough) ?? 10) *
    power;
  return integer ? Math.ceil(step) : step;
}

function TrendChart({
  snapshot,
  staticMode,
}: {
  snapshot: BusinessBoardSnapshot;
  staticMode: boolean;
}) {
  const { trend } = snapshot;
  const expense = snapshot.scope.system === 'expense';
  const unit = expense ? '元' : '次';
  const [active, setActive] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, '');
  const step = niceStep(
    Math.max(0, ...trend.map((row) => row.value)),
    !expense,
  );
  const top = step * 3;
  const x = (i: number) =>
    trend.length > 1 ? (i / (trend.length - 1)) * 100 : 50;
  const y = (v: number) => 100 - (v / top) * 100;
  const points = trend.map((row, i) => [x(i), y(row.value)]);
  const line = points
    .map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`)
    .join(' ');
  const row = active == null ? null : trend[active];
  const period = (item: (typeof trend)[number]) =>
    item.endDate && item.endDate !== item.date
      ? boardDateLabel({ startDate: item.date, endDate: item.endDate })
      : item.label;
  const axisIndices = Array.from(
    new Set([
      0,
      Math.floor((trend.length - 1) / 3),
      Math.round((2 * (trend.length - 1)) / 3),
      trend.length - 1,
    ]),
  );
  const subject = expense ? '各期报销费用' : '各期出差次数';
  const selected = row ?? trend[0];
  const plot: HTMLAttributes<HTMLDivElement> = staticMode
    ? { role: 'img', 'aria-label': subject }
    : {
        role: 'slider',
        'aria-label': subject,
        'aria-valuemin': 1,
        'aria-valuemax': trend.length,
        'aria-valuenow': (active ?? 0) + 1,
        'aria-valuetext': selected
          ? `${period(selected)}，${number(selected.value)}${unit}`
          : undefined,
        tabIndex: 0,
        onBlur: () => setActive(null),
        onFocus: () => setActive((i) => i ?? 0),
        onPointerMove: (event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const index = Math.round(
            ((event.clientX - bounds.left) / bounds.width) * (trend.length - 1),
          );
          setActive(Math.max(0, Math.min(trend.length - 1, index)));
        },
        onPointerLeave: (event) => {
          if (document.activeElement !== event.currentTarget) setActive(null);
        },
        onKeyDown: (event) => {
          const index = active ?? 0;
          const next: Record<string, number> = {
            Home: 0,
            End: trend.length - 1,
            ArrowLeft: index - 1,
            ArrowRight: index + 1,
          };
          if (!Object.hasOwn(next, event.key)) return;
          event.preventDefault();
          setActive(Math.max(0, Math.min(trend.length - 1, next[event.key]!)));
        },
      };
  return (
    <ChartFrame
      view="trend"
      title={expense ? '报销费用走势' : '出差频次走势'}
      meta={`${snapshot.trendGrain ? { day: '按日', sevenDays: '每 7 天汇总', month: '按月' }[snapshot.trendGrain] : '单位'} · ${unit}`}
    >
      {trend.length > 0 && (
        <div className="bb-trend">
          <div className="bb-yaxis" aria-hidden="true">
            {[top, step * 2, step, 0].map((n) => (
              <span key={n}>{number(n)}</span>
            ))}
          </div>
          <div className="bb-trend-column">
            <div className="bb-plot" {...plot}>
              <svg
                aria-hidden="true"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#69abc7" stopOpacity=".38" />
                    <stop offset="100%" stopColor="#c5e7ed" stopOpacity=".12" />
                  </linearGradient>
                </defs>
                {[0, 100 / 3, 200 / 3, 100].map((py) => (
                  <line
                    key={py}
                    x1="0"
                    x2="100"
                    y1={py}
                    y2={py}
                    stroke="#dbe3e8"
                    strokeDasharray="3 4"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <path
                  d={`${line} L${x(trend.length - 1)},100 L${x(0)},100 Z`}
                  fill={`url(#${gradientId})`}
                />
                <path
                  d={line}
                  fill="none"
                  stroke="#246b91"
                  strokeWidth="2.4"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {trend.length === 1 && (
                <i
                  className="bb-dot"
                  style={{ left: '50%', top: y(trend[0]!.value) + '%' }}
                />
              )}
              {row && active !== null && (
                <>
                  <i
                    className="bb-hairline"
                    style={{ left: x(active) + '%' }}
                  />
                  <i
                    className="bb-dot"
                    style={{ left: x(active) + '%', top: y(row.value) + '%' }}
                  />
                  <span
                    className="bb-chart-tip"
                    style={
                      x(active) > 53
                        ? { right: 100 - x(active) + '%' }
                        : { left: x(active) + '%' }
                    }
                  >
                    {period(row)}
                    <b>
                      {number(row.value)} {unit}
                    </b>
                  </span>
                </>
              )}
            </div>
            <div className="bb-xaxis" aria-hidden="true">
              {axisIndices.map((i) => (
                <span key={i}>{trend[i]!.label}</span>
              ))}
            </div>
          </div>
        </div>
      )}
      {staticMode && trend.length > 0 && (
        <details className="bb-trend-data">
          <summary>查看趋势数据（{trend.length} 期）</summary>
          <table className="bb-routes">
            <thead>
              <tr>
                <th scope="col">统计期起始日</th>
                <th scope="col">
                  {expense ? '报销费用（元）' : '出差行程（次）'}
                </th>
              </tr>
            </thead>
            <tbody>
              {trend.map((part) => (
                <tr key={part.date}>
                  <th scope="row">{part.date}</th>
                  <td>{expense ? amount(part.value) : number(part.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </ChartFrame>
  );
}

function Breakdown({ snapshot }: { snapshot: BusinessBoardSnapshot }) {
  const expense = snapshot.scope.system === 'expense';
  const parts = snapshot.breakdown.filter((r) => r.value > 0);
  const total = parts.reduce((sum, r) => sum + r.value, 0);
  let offset = 0;
  return (
    <ChartFrame
      view="breakdown"
      title={expense ? '费用构成' : '出行方式'}
      meta={expense ? '按费用类型' : '按行程次数'}
    >
      {total ? (
        <div className="bb-mix">
          <div className="bb-ring">
            <svg
              viewBox="0 0 120 120"
              role="img"
              aria-label={parts
                .map((r) => `${r.name} ${number((100 * r.value) / total)}%`)
                .join('，')}
            >
              {parts.map((r, index) => {
                const start = offset;
                const share = (100 * r.value) / total;
                offset += share;
                return (
                  <circle
                    key={r.name}
                    cx="60"
                    cy="60"
                    r="47"
                    fill="none"
                    stroke={palette[index % palette.length]}
                    strokeWidth="13"
                    pathLength="100"
                    strokeDasharray={`${Math.max(0, share - (parts.length > 1 ? 0.6 : 0))} 100`}
                    strokeDashoffset={-start}
                    transform="rotate(-90 60 60)"
                  />
                );
              })}
            </svg>
            <div>
              <strong>
                {((100 * parts[0]!.value) / total).toFixed(1)}
                <small>%</small>
              </strong>
              <span>{parts[0]!.name}</span>
            </div>
          </div>
          <ul className="bb-mix-key">
            {parts.map((r, i) => (
              <li key={r.name}>
                <i style={{ background: palette[i % palette.length] }} />
                <span>{r.name}</span>
                <b title={`${number(r.value)}${expense ? '元' : '次'}`}>
                  {((100 * r.value) / total).toFixed(1)}%
                </b>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <EmptyFigure>暂无分类数据</EmptyFigure>
      )}
    </ChartFrame>
  );
}

function EmptyFigure({ children }: { children: ReactNode }) {
  return <p className="bb-no-rows">{children}</p>;
}

function Ranking({ snapshot }: { snapshot: BusinessBoardSnapshot }) {
  const rows = snapshot.ranking.slice(0, 5);
  const highest = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <ChartFrame
      view="ranking"
      title="员工差旅费用排行"
      meta={snapshot.ranking.length > 5 ? '金额前 5 名' : '按金额排序'}
    >
      {rows.length ? (
        <ol className="bb-ranking">
          {rows.map((r, i) => (
            <li key={r.department + r.name}>
              <span className="bb-rank-no">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="bb-rank-person">
                <b>{r.name}</b>
                <span>
                  {r.department} · {r.trips} 次出差
                </span>
              </div>
              <div className="bb-rank-amount">
                <strong>
                  {amount(r.amount)} <small>元</small>
                </strong>
                <div className="bb-rank-track">
                  <i style={{ width: (100 * r.amount) / highest + '%' }} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyFigure>当前范围没有员工差旅费用</EmptyFigure>
      )}
    </ChartFrame>
  );
}

function Routes({
  snapshot,
  byAmount = false,
  onSort,
}: {
  snapshot: BusinessBoardSnapshot;
  byAmount?: boolean;
  onSort?: (byAmount: boolean) => void;
}) {
  const ordered = byAmount
    ? [...snapshot.routes].sort(
        (a, b) => b.amount - a.amount || b.trips - a.trips,
      )
    : snapshot.routes;
  const rows = ordered.slice(0, 5);
  return (
    <ChartFrame
      view={byAmount ? 'routeSpend' : 'travel'}
      title={byAmount ? '线路差旅费用' : '差旅行程分布'}
      meta={
        onSort ? (
          <label className="bb-route-sort">
            {ordered.length > rows.length && <span>前 {rows.length} 条</span>}
            <select
              aria-label="线路排序"
              value={byAmount ? 'amount' : 'trips'}
              onChange={(event) => onSort(event.target.value === 'amount')}
            >
              <option value="trips">按行程次数</option>
              <option value="amount">按差旅费用</option>
            </select>
          </label>
        ) : byAmount ? (
          '按差旅费用排序'
        ) : snapshot.routes.length > 5 ? (
          '行程前 5 条线路'
        ) : (
          '按行程次数排序'
        )
      }
    >
      {rows.length ? (
        <table className="bb-routes">
          <thead>
            <tr>
              <th scope="col">出差线路</th>
              <th scope="col">行程</th>
              <th scope="col">差旅费用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td>{number(r.trips)} 次</td>
                <td>{amount(r.amount)} 元</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyFigure>当前范围没有差旅行程</EmptyFigure>
      )}
    </ChartFrame>
  );
}

function Departments({ snapshot }: { snapshot: BusinessBoardSnapshot }) {
  const expense = snapshot.scope.system === 'expense';
  const rows = snapshot.departments;
  const highest = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ChartFrame
      title={expense ? '各部门报销费用' : '各部门出差行程'}
      meta={snapshot.departmentLabel}
    >
      <ul className="bb-dept-list">
        {rows.map((r) => (
          <li key={r.name}>
            <span>{r.name}</span>
            <div className="bb-rank-track">
              <i style={{ width: (100 * r.value) / highest + '%' }} />
            </div>
            <strong>
              {number(r.value)} {expense ? '元' : '次'}
            </strong>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

export function BusinessBoardVisuals({
  snapshot,
  view = 'overview',
  metricId,
  compact = false,
  staticMode = false,
  showComparison = false,
  routeByAmount = false,
  onRouteSort,
  overviewDetails = compact ? [] : ['breakdown', 'ranking', 'travel'],
}: {
  snapshot: BusinessBoardSnapshot;
  view?: BoardView;
  metricId?: string;
  compact?: boolean;
  staticMode?: boolean;
  showComparison?: boolean;
  routeByAmount?: boolean;
  onRouteSort?: (byAmount: boolean) => void;
  overviewDetails?: BoardView[];
}) {
  const { scope, coverage } = snapshot;
  const outside =
    coverage &&
    (scope.endDate < coverage.startDate || scope.startDate > coverage.endDate);
  const partial =
    coverage &&
    (scope.startDate < coverage.startDate || scope.endDate > coverage.endDate);
  const empty = (
    <div className="bb-empty" role="status">
      <Icon name="chart" size={26} />
      <strong>
        {outside
          ? '所选日期超出台账覆盖期'
          : partial
            ? '已覆盖日期内暂无业务记录'
            : '所选范围暂无业务记录'}
      </strong>
      <span>
        {coverage
          ? `台账覆盖 ${boardDateLabel(coverage)}，可调整日期或部门。`
          : '可调整统计日期或部门范围。'}
      </span>
    </div>
  );
  if (
    !snapshot.recordCount &&
    (!showComparison || snapshot.comparison === undefined || outside)
  )
    return empty;
  const overview = view === 'overview';
  const selected = overview && metricId
    ? snapshot.metrics.find((metric) => metric.id === metricId)
    : undefined;
  return (
    <div
      className={`bb-visuals${compact ? ' bb-compact' : ''}${overview ? '' : ' bb-focused'}`}
    >
      {partial && coverage && (
        <p className="bb-coverage">
          所选日期超出台账覆盖期，本次仅统计{' '}
          {boardDateLabel({
            startDate:
              scope.startDate > coverage.startDate
                ? scope.startDate
                : coverage.startDate,
            endDate:
              scope.endDate < coverage.endDate
                ? scope.endDate
                : coverage.endDate,
          })}
          {showComparison && snapshot.comparison === null
            ? '，暂无前期对比。'
            : '。'}
        </p>
      )}
      {overview && (!partial || snapshot.recordCount > 0) && (
        <Metrics snapshot={snapshot} compare={showComparison && !partial} selected={selected} />
      )}
      {snapshot.recordCount === 0 ? (
        empty
      ) : !selected && (
        <div className="bb-chart-grid">
          {(overview || view === 'trend') && (
            <TrendChart snapshot={snapshot} staticMode={staticMode} />
          )}
          {((overview && overviewDetails.includes('breakdown')) ||
            view === 'breakdown') && <Breakdown snapshot={snapshot} />}
          {((overview && overviewDetails.includes('ranking')) ||
            view === 'ranking') && <Ranking snapshot={snapshot} />}
          {((overview && overviewDetails.includes('travel')) ||
            view === 'travel') && (
            <Routes
              snapshot={snapshot}
              byAmount={routeByAmount}
              onSort={onRouteSort}
            />
          )}
          {((overview && overviewDetails.includes('routeSpend')) ||
            view === 'routeSpend') && <Routes snapshot={snapshot} byAmount />}
        </div>
      )}
      {overview && !selected &&
        !compact &&
        snapshot.scope.departmentIds.length > 1 &&
        snapshot.departments.length > 0 && <Departments snapshot={snapshot} />}
    </div>
  );
}
