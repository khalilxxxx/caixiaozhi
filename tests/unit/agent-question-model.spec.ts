import { describe, expect, it } from 'vitest';
import {
  answerSummary,
  pendingQuestion,
  questionState,
  prepareQuestionAnswer,
  continuedQuestionPanel,
  resumeQuestionMessage,
  continuationDraftId,
} from '../../apps/web/src/demos/agent-workspace/question-model';
import { conversationState } from '../../apps/web/src/demos/agent-workspace/conversation-model';
import type { Task } from '../../apps/web/src/demos/agent-workspace/workspace';

const question = {
  id: 'q-travel',
  title: '这次北京行程如何办理？',
  multiple: false,
  status: 'pending' as const,
  draftId: 'travel',
  draftVersion: 2,
  options: [
    { id: 'new', label: '新建北京差旅申请' },
    { id: 'edit', label: '修改现有上海申请' },
  ],
};
const task = {
  id: 'task-travel',
  title: '北京出差',
  type: 'submission',
  status: '待你回答',
  input: '',
  refs: [],
  updated: '',
  messages: [{ id: 'm1', role: 'assistant', text: '', question }],
} as Task;
const data = {
  submissions: { drafts: { travel: { version: 2, status: 'draft' } } },
};

describe('Agent 结构化追问', () => {
  it('新稿已保存后暂停，继续处理不会再次发送新建指令', () => {
    const interrupted = {
      ...task,
      status: '已暂停',
      refs: [{ kind: 'submission', id: 'travel-created', title: '北京申请' }],
      messages: [
        {
          id: 'new-request',
          role: 'user' as const,
          text: '另建一份北京出差申请',
        },
        {
          id: 'saved',
          role: 'assistant' as const,
          text: '任务已暂停',
          submissionPhase: 'ready' as const,
          tools: [{ name: 'new_submission_draft', status: 'completed' }],
          cards: [
            { kind: 'submission', id: 'travel-created', title: '北京申请' },
          ],
        },
      ],
    };
    const message = resumeQuestionMessage(interrupted);
    expect(message).toContain('当前已保存的草稿');
    expect(message).not.toContain('另建一份');
  });
  it('只读取旧稿后暂停，继续仍保留尚未执行的新建要求', () => {
    const interrupted = {
      ...task,
      refs: [{ kind: 'submission', id: 'travel-old', title: '旧申请' }],
      messages: [
        {
          id: 'new-request',
          role: 'user' as const,
          text: '另建一份北京出差申请',
        },
        {
          id: 'read',
          role: 'assistant' as const,
          text: '任务已暂停',
          cards: [{ kind: 'submission', id: 'travel-old', title: '旧申请' }],
          tools: [{ name: 'get_submission_draft', status: 'completed' }],
        },
      ],
    };
    expect(resumeQuestionMessage(interrupted)).toBe('另建一份北京出差申请');
  });
  it('回答后刷新重连可从已保存答案恢复原草稿，普通后续消息不会误用旧问题', () => {
    const answering = {
      ...task,
      messages: [
        {
          ...task.messages[0]!,
          question: { ...question, status: 'answered' as const },
        },
        {
          id: 'answer',
          role: 'user' as const,
          text: '新建北京申请',
          questionAnswer: { questionId: question.id, optionIds: ['new'] },
        },
      ],
    };
    expect(continuationDraftId(answering)).toBe('travel');
    expect(
      continuedQuestionPanel(
        { kind: 'submission', id: 'travel', title: '上海申请' },
        continuationDraftId(answering),
        {
          ...answering,
          refs: [{ kind: 'submission', id: 'travel-new', title: '北京申请' }],
        },
      )?.id,
    ).toBe('travel-new');
    expect(
      continuationDraftId({
        ...answering,
        messages: [
          ...answering.messages,
          { id: 'later', role: 'user', text: '修改上海草稿' },
        ],
      }),
    ).toBeUndefined();
  });
  it('稍后回答或旧版暂不处理后继续办理会恢复任务，而不会重复发送暂停文案', () => {
    for (const deferredText of ['稍后回答', '暂不处理']) {
      const deferred = {
        ...task,
        messages: [
          {
            ...task.messages[0]!,
            question: { ...question, status: 'deferred' as const },
          },
          { id: 'defer', role: 'user' as const, text: deferredText },
        ],
      };
      expect(resumeQuestionMessage(deferred)).toBe(
        '继续刚才暂缓的任务，请根据当前信息确认下一步。',
      );
    }
    expect(
      resumeQuestionMessage({
        ...task,
        messages: [{ id: 'user', role: 'user', text: '帮我填写差旅申请' }],
      }),
    ).toBe('帮我填写差旅申请');
  });
  it('新建回答完成后将原单抽屉切换到新实例，后续消息不会继续修改旧单', () => {
    const result = {
      ...task,
      refs: [{ kind: 'submission', id: 'travel-new', title: '北京差旅申请' }],
    };
    expect(
      continuedQuestionPanel(
        {
          kind: 'submission',
          id: 'travel',
          title: '上海申请',
          data: { step: 'confirm' },
        },
        'travel',
        result,
      ),
    ).toEqual({
      kind: 'submission',
      id: 'travel-new',
      title: '北京差旅申请',
      data: { view: 'edit' },
    });
    expect(
      continuedQuestionPanel(
        { kind: 'submission', id: 'another-draft', title: '另一份申请' },
        'travel',
        result,
      ),
    ).toBeNull();
    expect(continuedQuestionPanel(null, 'travel', result)).toBeNull();
  });
  it('将选项与自由补充同时关联到原问题', () => {
    const result = prepareQuestionAnswer(
      task,
      { questionId: question.id, optionIds: ['new'], text: ' 上海那份保留 ' },
      data,
    );
    expect(result.message).toBe('新建北京差旅申请；上海那份保留');
    expect(result.answer).toEqual({
      questionId: 'q-travel',
      optionIds: ['new'],
      text: '上海那份保留',
    });
  });
  it('允许完全用文字回答且不伪造选项', () => {
    expect(
      prepareQuestionAnswer(
        task,
        { questionId: question.id, text: '先不改，我核实下行程' },
        data,
      ).answer.optionIds,
    ).toEqual([]);
  });
  it('要求真实回答，阻止不存在的选项和单选多答', () => {
    expect(() =>
      prepareQuestionAnswer(task, { questionId: question.id }, data),
    ).toThrow('请选择一项或输入回答');
    expect(() =>
      prepareQuestionAnswer(
        task,
        { questionId: question.id, optionIds: ['missing'] },
        data,
      ),
    ).toThrow('选项已变化');
    expect(() =>
      prepareQuestionAnswer(
        task,
        { questionId: question.id, optionIds: ['new', 'edit'] },
        data,
      ),
    ).toThrow('只能选择一项');
  });
  it('多选摘要按问题选项顺序展示，不依赖点击顺序', () => {
    const multi = { ...question, multiple: true };
    const current = {
      ...task,
      messages: [{ ...task.messages[0]!, question: multi }],
    };
    expect(
      prepareQuestionAnswer(
        current,
        { questionId: multi.id, optionIds: ['edit', 'new'] },
        data,
      ).message,
    ).toBe('新建北京差旅申请、修改现有上海申请');
  });
  it('稍后回答不混入未提交的选项或说明', () => {
    expect(
      prepareQuestionAnswer(
        task,
        {
          questionId: question.id,
          optionIds: ['edit'],
          text: '未提交',
          deferred: true,
        },
        data,
      ),
    ).toEqual({
      message: '稍后回答',
      answer: {
        questionId: question.id,
        optionIds: [],
        text: '',
        deferred: true,
      },
    });
  });
  it('拒绝跨会话、已回答与旧版本问题', () => {
    expect(() =>
      prepareQuestionAnswer(
        { ...task, messages: [] },
        { questionId: question.id, optionIds: ['new'] },
        data,
      ),
    ).toThrow('问题已失效');
    const answered = {
      ...task,
      messages: [
        {
          ...task.messages[0]!,
          question: { ...question, status: 'answered' as const },
        },
      ],
    };
    expect(() =>
      prepareQuestionAnswer(
        answered,
        { questionId: question.id, text: '新建' },
        data,
      ),
    ).toThrow('问题已失效');
    expect(
      questionState(question, {
        submissions: { drafts: { travel: { version: 3 } } },
      }),
    ).toBe('expired');
    expect(questionState(question, { submissions: { drafts: {} } })).toBe(
      'expired',
    );
    expect(() =>
      prepareQuestionAnswer(
        task,
        { questionId: question.id, text: '新建' },
        {},
      ),
    ).toThrow('草稿已变化');
  });
  it('仅保留最新待回答问题，已回答问题摘要可恢复', () => {
    const latest = { ...question, id: 'q-latest' };
    const current = {
      ...task,
      messages: [
        ...task.messages,
        { id: 'm2', role: 'assistant' as const, text: '', question: latest },
      ],
    };
    expect(pendingQuestion(current)?.id).toBe('q-latest');
    expect(() =>
      prepareQuestionAnswer(
        current,
        { questionId: question.id, text: '新建' },
        data,
      ),
    ).toThrow('问题已失效');
    expect(
      answerSummary({
        ...question,
        status: 'answered',
        answer: { optionIds: ['new'], text: '保留上海申请' },
      }),
    ).toBe('新建北京差旅申请；保留上海申请');
  });
  it('待你回答在会话列表中显示待处理状态', () => {
    expect(conversationState(task)).toEqual({
      icon: 'alert',
      label: '待你回答',
      tone: 'amber',
    });
  });
});
