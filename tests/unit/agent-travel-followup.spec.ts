import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPage } from '../../apps/web/src/demos/agent-workspace/Chat';
import { SubmissionCard } from '../../apps/web/src/demos/agent-workspace/SubmissionCard';
import { createInitialDrafts } from '../../apps/web/src/demos/agent-workspace/submission-model';
import { latestSubmissionCards } from '../../apps/web/src/demos/agent-workspace/submission-conversation';
import {
  WorkspaceContext,
  type WorkspaceAPI,
  type Task,
} from '../../apps/web/src/demos/agent-workspace/workspace';

const webRequire = createRequire(
  new URL('../../apps/web/package.json', import.meta.url),
);
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const card = { kind: 'submission', id: 'travel', title: '差旅申请' };
const question = {
  id: 'q',
  title: '哪天出发？',
  options: [],
  multiple: false,
  status: 'pending' as const,
};
const draft = () => ({
  ...createInitialDrafts().travel,
  purpose: '北京客户拜访',
  returnDatePending: true,
  legs: [
    {
      id: 'go',
      departureCity: '杭州',
      arrivalCity: '北京',
      departureDate: '2026-11-19',
      arrivalDate: '2026-11-19',
      transport: '飞机-经济舱',
    },
    {
      id: 'return',
      departureCity: '北京',
      arrivalCity: '杭州',
      departureDate: '',
      arrivalDate: '',
      transport: '飞机-经济舱',
      isReturn: true,
    },
  ],
});
function render(component: unknown, props: unknown, currentDraft = draft()) {
  const api = {
    state: {
      data: {
        submissions: {
          drafts: { ...createInitialDrafts(), travel: currentDraft },
          edits: {},
          checks: {},
          requests: [],
        },
      },
      tasks: [],
      activeTask: null,
    },
  } as unknown as WorkspaceAPI;
  return renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: api },
      createElement(component, props),
    ),
  );
}
function task(messages: Task['messages']): Task {
  return {
    id: 't',
    title: '北京出差',
    type: 'submission',
    status: '待你回答',
    input: '',
    refs: [],
    updated: '',
    messages,
  };
}

describe('差旅追问与草稿展示', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('追问阶段保留问题和其他结果，暂不展示差旅卡片', () => {
    const current = task([
      {
        id: 'ask',
        role: 'assistant',
        text: '',
        submissionPhase: 'collecting',
        question,
        cards: [
          card,
          { kind: 'knowledge', title: '差旅规定', subtitle: '可查看当前制度' },
        ],
      },
    ]);
    const html = render(ChatPage, {
      task: current,
      busy: false,
      composer: null,
      onRename() {},
    });
    expect(html).toContain('哪天出发？');
    expect(html).toContain('差旅规定');
    expect(html).not.toContain('差旅申请草稿卡片');
  });

  it('后台保存草稿时不产生空回复，继续显示处理状态', () => {
    vi.stubGlobal('document', { hidden: false });
    const html = render(ChatPage, {
      task: task([
        {
          id: 'work',
          role: 'assistant',
          text: '',
          submissionPhase: 'collecting',
          cards: [card],
        },
      ]),
      busy: true,
      composer: null,
      onRename() {},
    });
    expect(html).toContain('正在处理');
    expect(html.match(/class="run-progress is-running"/g)).toHaveLength(1);
    expect(html).not.toContain('差旅申请草稿卡片');
    expect(html).not.toContain('复制回复');
  });

  it.each(['answered', 'deferred', 'expired'] as const)(
    '追问已结束（%s）时历史消息不再提示待回答',
    (status) => {
      const current = task([
        {
          id: 'old',
          role: 'assistant',
          text: '',
          runStatus: 'awaiting_input',
          question: { ...question, status },
        },
      ]);
      current.status = '已完成';
      const html = render(ChatPage, {
        task: current,
        busy: false,
        composer: null,
      });
      expect(html).not.toContain('run-progress is-waiting');
      expect(html).toContain('question-history');
    },
  );

  it('服务重启后按消息的中断状态展示，回看不计入停机时间', () => {
    const current = task([
      {
        id: 'old',
        role: 'assistant',
        text: '服务已重启，上次任务已暂停。',
        runStatus: 'interrupted',
        runStartedAt: 1_790_000_000_000,
        runFinishedAt: 1_790_003_600_000,
        tools: [{ name: 'query_documents', status: 'cancelled' }],
      },
    ]);
    current.status = '已暂停';
    const html = render(ChatPage, {
      task: current,
      busy: false,
      composer: null,
    });
    expect(html).toContain('服务已重启');
    expect(html).toContain('本轮进展');
    expect(html).not.toContain('用时');
  });

  it.each(['ready', undefined] as const)(
    '完成追问或历史消息可展示可编辑草稿（%s）',
    (submissionPhase) => {
      const html = render(ChatPage, {
        task: task([
          {
            id: 'done',
            role: 'assistant',
            text: '草稿已整理',
            submissionPhase,
            cards: [card],
          },
        ]),
        busy: false,
        composer: null,
        onRename() {},
      });
      expect(html).toContain('差旅申请草稿卡片');
      expect(html).toContain('补充信息');
    },
  );

  it('未发布草稿不会使已展示的卡片被标为历史，索引仍对应原始卡数组', () => {
    const current = task([
      {
        id: 'shown',
        role: 'assistant',
        text: '',
        cards: [{ kind: 'knowledge', title: '制度' }, card],
      },
      {
        id: 'pending',
        role: 'assistant',
        text: '',
        submissionPhase: 'collecting',
        cards: [card],
      },
    ]);
    expect([...latestSubmissionCards(current)]).toEqual(['shown:1']);
  });

  it('待补回程明确显示日期缺失，补齐后恢复完整期间', () => {
    const before = render(SubmissionCard, { card });
    expect(before).toContain('2026.11.19 出发 · 回程日期待补');
    const filled = draft();
    filled.returnDatePending = false;
    filled.legs[1]!.departureDate = '2026-11-21';
    filled.legs[1]!.arrivalDate = '2026-11-21';
    const after = render(SubmissionCard, { card }, filled);
    expect(after).toContain('2026.11.19 — 2026.11.21');
    expect(after).not.toContain('回程日期待补');
  });
});
