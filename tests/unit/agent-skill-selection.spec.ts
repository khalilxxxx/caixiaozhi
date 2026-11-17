import { describe, expect, it } from 'vitest';
import {
  readSkillDraftTarget,
  saveSkillDraftTarget,
  selectSkillDraft,
} from '../../apps/web/src/demos/agent-workspace/skill-selection';
import type {
  WorkspaceState,
  Task,
} from '../../apps/web/src/demos/agent-workspace/workspace';

const skill = {
  kind: 'skill',
  id: 'analysis',
  title: '费用分析',
  version: '1.2',
};
const home = {
  input: '分析本月费用',
  refs: [{ kind: 'file', id: 'csv-1', title: '费用.csv' }],
  capability: 'analysis' as const,
};
const task: Task = {
  id: 'task-1',
  title: '已有会话',
  status: '待开始',
  type: 'chat',
  messages: [],
  input: '已填写的问题',
  refs: [
    { kind: 'skill', id: 'analysis', title: '费用分析', version: '1.0' },
    { kind: 'file', id: 'file-1', title: '原始文件' },
  ],
  updated: '刚刚',
};

describe('从目录选择技能的草稿续接', () => {
  it('没有当前会话时保留首页文字附件和能力，不创建空会话', () => {
    const state: WorkspaceState = { data: {}, tasks: [], activeTask: null };
    const result = selectSkillDraft(state, home, null, skill);
    expect(result.page).toBe('home');
    expect(result.state.tasks).toEqual([]);
    expect(result.state.activeTask).toBeNull();
    expect(result.home.input).toBe('分析本月费用');
    expect(result.home.capability).toBe('analysis');
    expect(result.home.refs).toEqual([
      { kind: 'file', id: 'csv-1', title: '费用.csv' },
      skill,
    ]);
  });
  it('原会话只替换同技能版本，保留输入文件消息和独立首页草稿', () => {
    const state: WorkspaceState = {
      data: {},
      tasks: [task],
      activeTask: 'task-1',
    };
    const result = selectSkillDraft(state, home, 'task-1', skill);
    expect(result.page).toBe('chat');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.tasks[0]?.input).toBe('已填写的问题');
    expect(result.state.tasks[0]?.messages).toEqual([]);
    expect(result.state.tasks[0]?.refs).toEqual([
      { kind: 'file', id: 'file-1', title: '原始文件' },
      skill,
    ]);
    expect(result.home).toEqual(home);
    expect(task.refs[0]?.version).toBe('1.0');
  });
  it('目标会话已不存在时回到首页草稿，不复活或创建会话', () => {
    const state: WorkspaceState = {
      data: {},
      tasks: [],
      activeTask: 'deleted',
    };
    const result = selectSkillDraft(state, home, 'deleted', skill);
    expect(result.page).toBe('home');
    expect(result.state.tasks).toEqual([]);
    expect(result.home.refs).toHaveLength(2);
  });
});

function draftStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe('目录刷新后的草稿目标恢复', () => {
  it('在工作区异步恢复前读回会话目标，选择后续接原输入和附件', () => {
    const storage = draftStorage();
    saveSkillDraftTarget('task-1', storage);
    const restoredTarget = readSkillDraftTarget(storage);
    const loadedState: WorkspaceState = {
      data: {},
      tasks: [task],
      activeTask: 'task-1',
    };
    const result = selectSkillDraft(loadedState, home, restoredTarget, skill);
    expect(result.page).toBe('chat');
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.tasks[0]).toMatchObject({
      id: 'task-1',
      input: '已填写的问题',
      refs: [{ kind: 'file', id: 'file-1', title: '原始文件' }, skill],
    });
    expect(result.home).toEqual(home);
  });

  it('首页来源显式覆盖旧会话目标，刷新后不绑定服务端残留的 activeTask', () => {
    const storage = draftStorage();
    saveSkillDraftTarget('task-1', storage);
    saveSkillDraftTarget(null, storage);
    const loadedState: WorkspaceState = {
      data: {},
      tasks: [task],
      activeTask: 'task-1',
    };
    const result = selectSkillDraft(
      loadedState,
      home,
      readSkillDraftTarget(storage),
      skill,
    );
    expect(result.page).toBe('home');
    expect(result.state).toBe(loadedState);
    expect(result.home).toEqual({ ...home, refs: [...home.refs, skill] });
  });

  it('缺失、损坏或不可读的目标安全回到首页，不阻断选择技能', () => {
    const invalidStorage = [
      { getItem: () => null },
      { getItem: () => '{broken' },
      { getItem: () => '{"targetId":"task-1"}' },
      {
        getItem: () => {
          throw new Error('storage blocked');
        },
      },
    ];
    for (const storage of invalidStorage) {
      const result = selectSkillDraft(
        { data: {}, tasks: [task], activeTask: 'task-1' },
        home,
        readSkillDraftTarget(storage),
        skill,
      );
      expect(result.page).toBe('home');
      expect(result.home.refs).toEqual([...home.refs, skill]);
    }
    expect(() =>
      saveSkillDraftTarget('task-1', {
        setItem: () => {
          throw new Error('storage blocked');
        },
      }),
    ).not.toThrow();
  });
});
