import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QuestionComposer,
  clearQuestionResponse,
  questionResponseKey,
  readQuestionResponse,
  writeQuestionResponse,
} from '../../apps/web/src/demos/agent-workspace/QuestionComposer';
import type { ClarificationQuestion } from '../../apps/web/src/demos/agent-workspace/question-model';
import {
  WorkspaceContext,
  type WorkspaceAPI,
} from '../../apps/web/src/demos/agent-workspace/workspace';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');

const question: ClarificationQuestion = {
  id: 'q-travel',
  title: '本次行程是否需要住宿？',
  description: '11 月 20 日出发，目的地上海。',
  status: 'pending',
  multiple: false,
  options: [
    { id: 'yes', label: '需要住宿', description: '行程中安排过夜住宿' },
    { id: 'no', label: '当天往返' },
  ],
};

let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

function render(current = question, busy = false) {
  const api = {
    state: {
      data: {},
      tasks: [{ id: 'task-a', input: '普通输入框尚未发送的内容' }],
      activeTask: 'task-a',
    },
  } as WorkspaceAPI;
  return renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: api },
      createElement(QuestionComposer, {
        question: current,
        taskId: 'task-a',
        busy,
        onStop() {},
      }),
    ),
  );
}

describe('输入区追问与普通消息分离', () => {
  it('只呈现一套回答输入，默认不选答案，未填写时不能发送', () => {
    const html = render();
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    expect(html).toContain('id="question-answer-input"');
    expect(html).toContain('aria-label="回答追问"');
    expect(html).toContain(question.title);
    expect(html).toContain(question.description);
    expect(html).toContain('行程中安排过夜住宿');
    expect(html).not.toMatch(/checked=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('发送回答');
    expect(html).toContain('稍后回答');
    expect(html).not.toContain('普通输入框尚未发送的内容');
  });

  it('恢复补充文字并允许不选选项直接发送', () => {
    writeQuestionResponse('task-a', question.id, {
      selected: [],
      text: '我要住一晚，第二天回程',
    });
    const html = render();
    expect(html).toContain('我要住一晚，第二天回程');
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(html).not.toMatch(/checked=""/);
  });

  it('多选草稿恢复各个选项及补充文字，不降级成普通文字消息', () => {
    writeQuestionResponse('task-a', question.id, {
      selected: ['yes', 'no'],
      text: '分别适用于两段行程',
    });
    const html = render({ ...question, multiple: true });
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('分别适用于两段行程');
  });

  it('忙碌时禁止修改和发送，并提供停止当前处理的操作', () => {
    const html = render(question, true);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('停止处理');
  });

  it('没有候选项的问题仍能通过同一个输入框填写', () => {
    const html = render({ ...question, options: [] });
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/type="(?:checkbox|radio)"/);
    expect(html).toContain('输入回答');
    expect(html).toContain('Enter 发送');
  });

  it('追问回答支持上传材料并在停止处理期间提供明确反馈', () => {
    const api = {
      state: { data: {}, tasks: [{ id: 'task-a', input: '' }], activeTask: 'task-a' },
    } as WorkspaceAPI;
    const withUpload = renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        { value: api },
        createElement(QuestionComposer, {
          question,
          taskId: 'task-a',
          busy: false,
          onUpload() {},
        }),
      ),
    );
    expect(withUpload).toContain('上传文件');
    const stoppingHtml = renderToStaticMarkup(
      createElement(
        WorkspaceContext.Provider,
        { value: api },
        createElement(QuestionComposer, {
          question,
          taskId: 'task-a',
          busy: true,
          stopping: true,
          onStop() {},
        }),
      ),
    );
    expect(stoppingHtml).toContain('正在停止');
  });
});

describe('追问回答草稿', () => {
  it('按会话和问题隔离，保留选项和未修剪的补充文字', () => {
    writeQuestionResponse('task-a', question.id, {
      selected: ['yes'],
      text: '  需要发票\n入住一晚  ',
    });
    expect(readQuestionResponse('task-a', question)).toEqual({
      selected: ['yes'],
      text: '  需要发票\n入住一晚  ',
    });
    expect(readQuestionResponse('task-b', question)).toEqual({
      selected: [],
      text: '',
    });
    expect(
      readQuestionResponse('task-a', { ...question, id: 'another-question' }),
    ).toEqual({ selected: [], text: '' });
    expect(questionResponseKey('a.b', 'c')).not.toBe(
      questionResponseKey('a', 'b.c'),
    );
  });

  it('兼容旧版已填答案，已有会话草稿优先且空草稿不被旧答案覆盖', () => {
    entries.set(
      `cx.agent.question.${question.id}`,
      JSON.stringify({ selected: ['no'], text: '旧版填写' }),
    );
    expect(readQuestionResponse('task-a', question)).toEqual({
      selected: ['no'],
      text: '旧版填写',
    });
    writeQuestionResponse('task-a', question.id, { selected: [], text: '' });
    expect(readQuestionResponse('task-a', question)).toEqual({
      selected: [],
      text: '',
    });
  });

  it('恢复时忽略失效和重复的选项，单选问题不恢复多个选择', () => {
    entries.set(
      questionResponseKey('task-a', question.id),
      JSON.stringify({ selected: ['missing', 'yes', 'yes', 'no', 2], text: 3 }),
    );
    expect(readQuestionResponse('task-a', question)).toEqual({
      selected: ['yes'],
      text: '',
    });
    expect(
      readQuestionResponse('task-a', { ...question, multiple: true }),
    ).toEqual({ selected: ['yes', 'no'], text: '' });
  });

  it('只有显式清理已解决的问题时才删除新旧键，其他会话草稿继续保留', () => {
    writeQuestionResponse('task-a', question.id, {
      selected: ['yes'],
      text: '待发送',
    });
    writeQuestionResponse('task-b', question.id, {
      selected: ['no'],
      text: '另一会话',
    });
    entries.set(`cx.agent.question.${question.id}`, '旧版草稿');
    clearQuestionResponse('task-a', question.id);
    expect(entries.has(questionResponseKey('task-a', question.id))).toBe(false);
    expect(entries.has(`cx.agent.question.${question.id}`)).toBe(false);
    expect(readQuestionResponse('task-b', question).text).toBe('另一会话');
  });

  it('损坏或不可访问的存储不阻止回答输入', () => {
    entries.set(questionResponseKey('task-a', question.id), 'invalid json');
    expect(readQuestionResponse('task-a', question)).toEqual({
      selected: [],
      text: '',
    });
    vi.stubGlobal('sessionStorage', {
      getItem() {
        throw new Error('Storage unavailable');
      },
      setItem() {
        throw new Error('Storage unavailable');
      },
      removeItem() {
        throw new Error('Storage unavailable');
      },
    });
    expect(render()).toContain('发送回答');
    expect(() =>
      writeQuestionResponse('task-a', question.id, {
        selected: [],
        text: '回答',
      }),
    ).not.toThrow();
    expect(() => clearQuestionResponse('task-a', question.id)).not.toThrow();
  });
});
