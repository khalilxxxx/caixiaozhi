import { describe, expect, it } from 'vitest';
import {
  createBlankExpense,
  createInitialDrafts,
  switchExpenseCategory,
} from '../../apps/web/src/demos/agent-workspace/submission-model.js';
import {
  activeSubmissionDefaults,
  setManualExpenseField,
} from '../../apps/web/src/demos/agent-workspace/submission-defaults.js';

function draftWithDefaults() {
  return {
    ...createInitialDrafts().travel,
    legs: [
      {
        id: 'go',
        departureCity: '杭州',
        arrivalCity: '上海',
        departureDate: '2026-11-18',
        arrivalDate: '2026-11-18',
        transport: '火车-二等座',
      },
    ],
    autoFill: {
      fields: {
        'legs.go.departureCity': {
          value: '杭州',
          label: '出发城市',
          ruleId: 'employee-base',
          source: '员工档案',
          basis: '常驻地为杭州',
        },
        'legs.go.transport': {
          value: '火车-二等座',
          label: '交通工具',
          ruleId: 'route-transport',
          source: '本地线路参考',
          basis: '短途铁路可达',
        },
      },
      suppressed: [] as string[],
    },
  };
}

describe('智能提单默认依据展示', () => {
  it('新增费用在保存前清空默认值时记录人工选择，类型切换保留该记录', () => {
    const expense = createBlankExpense('hotel');
    const cleared = setManualExpenseField(
      setManualExpenseField(expense, 'currency', ''),
      'rental',
      '',
    );
    expect(cleared.currency).toBe('');
    expect(cleared.rental).toBe('');
    expect(cleared.manualFields).toEqual(['currency', 'rental']);
    const switched = switchExpenseCategory(
      switchExpenseCategory(cleared, 'other-office'),
      'hotel',
    );
    expect(switched.manualFields).toEqual(['currency', 'rental']);
    expect(switched.currency).toBe('');
    expect(switched.rental).toBe('');
    expect(expense.currency).toBe('CNY');
  });

  it('只展示与当前草稿仍一致的默认值，人工修改和清空即时隐藏旧依据', () => {
    const draft = draftWithDefaults();
    expect(activeSubmissionDefaults(draft)).toHaveLength(2);
    draft.legs[0]!.departureCity = '北京';
    draft.legs[0]!.transport = '';
    expect(activeSubmissionDefaults(draft)).toEqual([]);
  });

  it('按稳定行程标识定位，重排后显示新的段号，删除段不留下依据', () => {
    const draft = draftWithDefaults();
    draft.legs.unshift({
      ...draft.legs[0]!,
      id: 'another',
      departureCity: '北京',
    });
    expect(activeSubmissionDefaults(draft).map((item) => item.label)).toEqual([
      '第2段出发城市',
      '第2段交通工具',
    ]);
    draft.legs = draft.legs.filter((leg) => leg.id !== 'go');
    expect(activeSubmissionDefaults(draft)).toEqual([]);
  });

  it('不显示主动取消的默认值或没有来源的旧草稿', () => {
    const draft = draftWithDefaults();
    draft.autoFill.suppressed.push('legs.go.transport');
    expect(activeSubmissionDefaults(draft).map((item) => item.path)).toEqual([
      'legs.go.departureCity',
    ]);
    expect(activeSubmissionDefaults(createInitialDrafts().travel)).toEqual([]);
  });
});
