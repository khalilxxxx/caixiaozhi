import {
  boardDateLabel,
  type BusinessBoardScope,
  type BusinessBoardSnapshot,
} from './business-board-model';
import type { ContextRef } from './workspace';

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
