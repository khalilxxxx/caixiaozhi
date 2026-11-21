import { describe, expect, it } from 'vitest';
import {
  boardReference,
  boardScopeFromHash,
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
});
