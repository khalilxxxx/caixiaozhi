export type BoardSystem = 'expense' | 'travel';

export interface BusinessBoardScope {
  system: BoardSystem;
  startDate: string;
  endDate: string;
  departmentIds: string[];
}

export interface BusinessBoardOptions {
  systems: { id: BoardSystem; name: string }[];
  departments: { id: string; name: string }[];
  defaultScope: BusinessBoardScope;
  source: string;
  coverage?: { startDate: string; endDate: string };
}

export interface BusinessBoardSnapshot {
  scope: BusinessBoardScope;
  title: string;
  departmentLabel: string;
  source: string;
  coverage?: { startDate: string; endDate: string };
  comparison?: {
    startDate: string;
    endDate: string;
    kind: 'previousMonth' | 'monthToDate' | 'previousPeriod';
    days: number;
    values: Record<string, number>;
  } | null;
  recordCount: number;
  metrics: { id: string; label: string; value: number; unit: string }[];
  trendGrain?: 'day' | 'sevenDays' | 'month';
  trend: { date: string; endDate?: string; label: string; value: number }[];
  breakdown: { name: string; value: number }[];
  ranking: {
    name: string;
    department: string;
    amount: number;
    trips: number;
  }[];
  routes: { name: string; trips: number; amount: number }[];
  departments: { name: string; value: number }[];
}

const boardViews = [
  'overview',
  'ranking',
  'travel',
  'routeSpend',
  'trend',
  'breakdown',
] as const;
export type BoardView = (typeof boardViews)[number];

export function boardViewFromHash(hash: string): BoardView {
  const view = new URLSearchParams(hash.split('?')[1]).get('view');
  return boardViews.find((item) => item === view) ?? 'overview';
}

export function businessBoardQuery(scope: BusinessBoardScope) {
  return new URLSearchParams({
    system: scope.system,
    startDate: scope.startDate,
    endDate: scope.endDate,
    departmentIds: scope.departmentIds.join(','),
  }).toString();
}

export function boardDateLabel(
  scope: Pick<BusinessBoardScope, 'startDate' | 'endDate'>,
) {
  const { startDate, endDate } = scope;
  const [year, month, day] = startDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = endDate.split('-').map(Number);
  const from = `${year}年${month}月${day}日`;
  if (startDate === endDate) return from;
  return `${from} – ${year !== toYear ? toYear + '年' : ''}${month !== toMonth || year !== toYear ? toMonth + '月' : ''}${toDay}日`;
}
