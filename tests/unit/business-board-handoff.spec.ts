import { describe, expect, it } from 'vitest';
import {
  boardReference,
  boardScopeFromHash,
  lastBoardScopeLabels,
} from '../../apps/web/src/demos/agent-workspace/business-board-handoff';
import {
  businessBoardQuery,
  type BusinessBoardScope,
} from '../../apps/web/src/demos/agent-workspace/business-board-model';

const scope: BusinessBoardScope = {
  system: 'travel',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  departmentIds: ['finance', 'research'],
};

describe('业务看板的会话引用', () => {
  it('往返后仍保留原业务系统、两个日期及选择的部门', () => {
    const ref = boardReference({
      scope,
      title: '差旅行程',
      departmentLabel: '财务部、研发部',
    });
    expect(ref.scope).toEqual(scope);
    expect(ref.title).toContain('财务部、研发部');
    expect(
      boardScopeFromHash('#analysis?' + businessBoardQuery(scope)),
    ).toEqual(scope);
  });
  it('普通入口及不完整的链接不提供看板范围', () => {
    expect(boardScopeFromHash('#analysis')).toBeUndefined();
    expect(boardScopeFromHash('#analysis?system=travel')).toBeUndefined();
  });
  it('生成报告后仍显示上次实际查询的范围，并区分新选中的报告', () => {
    const boardCard = (system: 'expense' | 'travel') => ({
      kind: 'analysis', title: '部门分析',
      data: {
        businessBoard: true, reportFollowupId: '第一次引用',
        snapshot: { scope: { ...scope, system }, departmentLabel: '财务部、研发部' },
      },
    });
    const messages = [
      { id: '1', role: 'assistant' as const, text: '已汇总', cards: [boardCard('expense'), boardCard('travel')] },
      { id: '2', role: 'assistant' as const, text: '报告已生成', cards: [
        { kind: 'report', title: '部门分析报告', data: { businessReport: true } },
      ] },
    ];
    expect(lastBoardScopeLabels(messages, '第一次引用')).toEqual([
      '报销、差旅 · 财务部、研发部 · 2026年9月1日 – 30日',
    ]);
    expect(lastBoardScopeLabels(messages, '第二次引用')).toEqual([]);
    expect(lastBoardScopeLabels([...messages, { id: '3', role: 'assistant', text: '已查询审批进度' }])).toEqual([]);
  });
});
