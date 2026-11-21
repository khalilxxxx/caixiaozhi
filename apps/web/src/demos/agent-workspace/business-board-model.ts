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
  recordCount: number;
  metrics: { id: string; label: string; value: number; unit: string }[];
  trend: { date: string; label: string; value: number }[];
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

export type BoardView =
  'overview' | 'ranking' | 'travel' | 'routeSpend' | 'trend' | 'breakdown';

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
