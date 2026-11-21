import {
  boardDateLabel,
  type BoardView,
  type BusinessBoardScope,
  type BusinessBoardSnapshot,
} from './business-board-model';
import type { ChatMessage, ContextRef } from './workspace';

export function boardReference(
  board: Pick<BusinessBoardSnapshot, 'scope' | 'title' | 'departmentLabel'>,
): ContextRef {
  return {
    kind: 'business-board',
    id: board.scope.system,
    title: [
      board.title,
      board.departmentLabel,
      boardDateLabel(board.scope),
    ].join(' · '),
    scope: board.scope,
  };
}

export function boardScopeFromHash(
  hash: string,
): BusinessBoardScope | undefined {
  const [page, query] = hash.split('?');
  if (page !== '#analysis' || !query) return;
  const params = new URLSearchParams(query);
  const system = params.get('system');
  const startDate = params.get('startDate');
  const endDate = params.get('endDate');
  const departmentIds = params.get('departmentIds')?.split(',').filter(Boolean);
  if (
    (system !== 'expense' && system !== 'travel') ||
    !startDate ||
    !endDate ||
    !departmentIds?.length
  )
    return;
  return { system, startDate, endDate, departmentIds };
}

export function boardAnalysisTitle(
  snapshot: BusinessBoardSnapshot,
  view: BoardView = 'overview',
  metricId?: string,
) {
  const metric = metricId && view === 'overview' && snapshot.metrics.find((item) => item.id === metricId);
  if (metric) return '部门' + metric.label;
  const expense = snapshot.scope.system === 'expense';
  const titles: Record<BoardView, string> = {
    overview: expense ? '部门报销费用概览' : '部门差旅行程概览',
    ranking: '员工差旅费排行',
    routeSpend: '各线路差旅费用',
    travel: '出差线路分布',
    trend: expense ? '报销费用趋势' : '出差频次趋势',
    breakdown: expense ? '报销费用构成' : '出行方式构成',
  };
  return titles[view] ?? snapshot.title;
}

/** Describe the last analytical reply, including questions answered with two boards. */
export function lastBoardScopeLabels(
  messages: ChatMessage[],
  reportFollowupId?: string,
) {
  const reply = [...messages].reverse().find((message) => {
    if (message.role !== 'assistant') return false;
    if (!message.cards?.length) return Boolean(message.text);
    // Generating a report preserves the scope of the preceding query.
    return !message.cards.every((card) => card.data?.businessReport);
  });
  const byRange = new Map<string, { systems: Set<string>; label: string }>();
  for (const card of reply?.cards ?? []) {
    if (reportFollowupId && card.data?.reportFollowupId !== reportFollowupId)
      continue;
    const snapshot: BusinessBoardSnapshot | undefined =
      card.data?.businessBoard && card.data?.snapshot;
    if (!snapshot?.scope) continue;
    const { system, startDate, endDate, departmentIds } = snapshot.scope;
    const key = JSON.stringify([startDate, endDate, [...departmentIds].sort()]);
    const group = byRange.get(key) ?? {
      systems: new Set<string>(),
      label: snapshot.departmentLabel + ' · ' + boardDateLabel(snapshot.scope),
    };
    group.systems.add(system === 'travel' ? '差旅' : '报销');
    byRange.set(key, group);
  }
  return Array.from(
    byRange.values(),
    (group) => Array.from(group.systems).join('、') + ' · ' + group.label,
  );
}
