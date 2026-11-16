import { describe, expect, it } from 'vitest';
import type { Task } from '../../apps/web/src/demos/agent-workspace/workspace';
import {
  appendDraft,
  needsAttention,
  selectHomeTasks,
} from '../../apps/web/src/demos/agent-workspace/task-model';

function task(id: string, status: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    status,
    title: `任务 ${id}`,
    type: 'chat',
    messages: [{ id: `${id}-message`, role: 'user', text: '查询当前办理进度' }],
    input: '',
    refs: [],
    updated: '刚刚',
    ...extra,
  };
}

describe('agent home task selection', () => {
  it('includes every task requiring the user, including a paused task', () => {
    const tasks = [
      task('check', '待我核对'),
      task('review', '待我审阅'),
      task('details', '待我补充'),
      task('paused', '已暂停'),
      task('approval', '等待审批'),
    ];
    expect(selectHomeTasks(tasks).attention.map((item) => item.id)).toEqual([
      'check',
      'review',
      'details',
      'paused',
    ]);
    expect(tasks.filter(needsAttention).length).toBe(4);
  });

  it('keeps tasks awaiting automated or external progress out of attention', () => {
    const result = selectHomeTasks([
      task('running', '处理中'),
      task('approval', '等待审批'),
      task('receipt', '待回执'),
      task('source', '待来源返回'),
      task('finished', '已完成'),
      task('cancelled', '已取消'),
    ]);
    expect(result.attention).toEqual([]);
    expect(result.ongoing.map((item) => item.id)).toEqual([
      'running',
      'approval',
      'receipt',
      'source',
    ]);
  });

  it('moves a task between sections as its status changes and removes completed tasks', () => {
    const original = task('expense', '待我确认');
    expect(selectHomeTasks([original]).attention).toEqual([original]);
    const waiting = { ...original, status: '待回执' };
    expect(selectHomeTasks([waiting])).toEqual({
      attention: [],
      ongoing: [waiting],
    });
    expect(selectHomeTasks([{ ...waiting, status: '已完成' }])).toEqual({
      attention: [],
      ongoing: [],
    });
  });

  it('does not count duplicate task IDs twice or show them in both sections', () => {
    const current = task('same', '待我补充');
    const result = selectHomeTasks([
      current,
      task('same', '处理中'),
      task('other', '等待审批'),
    ]);
    expect(result.attention.map((item) => item.id)).toEqual(['same']);
    expect(result.ongoing.map((item) => item.id)).toEqual(['other']);
  });

  it('excludes blank and unstarted tasks from ongoing work without hiding a contentful running task', () => {
    const result = selectHomeTasks([
      task('empty', '处理中', { messages: [], input: '  ', refs: [] }),
      task('new', '待开始', { messages: [], input: '', refs: [] }),
      task('working', '处理中'),
    ]);
    expect(result.ongoing.map((item) => item.id)).toEqual(['working']);
    expect(selectHomeTasks([])).toEqual({ attention: [], ongoing: [] });
  });
});

describe('home quick action drafts', () => {
  it('preserves an existing request when preparing another action', () => {
    expect(appendDraft('只处理已确认的材料', '帮我整理报销费用')).toBe(
      '只处理已确认的材料\n\n帮我整理报销费用',
    );
  });

  it('starts an empty draft and avoids adding the same shortcut twice', () => {
    expect(appendDraft('  ', '查询单据进展')).toBe('查询单据进展');
    expect(appendDraft('现有内容\n\n查询单据进展', '查询单据进展')).toBe(
      '现有内容\n\n查询单据进展',
    );
  });
});
