import type { Task, PanelSpec } from './workspace';

export function continuationDraftId(task: Task): string | undefined {
  const answer = task.messages
    .filter((message) => message.role === 'user')
    .at(-1)?.questionAnswer;
  return answer && !answer.deferred
    ? task.messages.find(
        (message) => message.question?.id === answer.questionId,
      )?.question?.draftId
    : undefined;
}

export function resumeQuestionMessage(task: Task): string {
  const latestUser = task.messages
    .filter((message) => message.role === 'user')
    .at(-1);
  const latestQuestion = task.messages
    .filter((message) => message.question)
    .at(-1)?.question;
  const target = task.refs.filter((ref) => ref.kind === 'submission').at(-1);
  const latestUserIndex = latestUser ? task.messages.indexOf(latestUser) : -1;
  const savedResult =
    target &&
    task.messages
      .slice(latestUserIndex + 1)
      .some(
        (message) =>
          message.tools?.some(
            (tool) =>
              tool.status === 'completed' &&
              ['new_submission_draft', 'update_submission_draft'].includes(
                tool.name,
              ),
          ) &&
          message.cards?.some(
            (card) => card.kind === 'submission' && card.id === target.id,
          ),
      );
  if (savedResult)
    return '继续处理当前已保存的草稿，保留已填写内容，接着完成尚未完成的步骤。';
  return latestQuestion?.status === 'deferred' &&
    latestUser?.text === '暂不处理'
    ? '继续刚才暂缓的任务，请根据当前信息确认下一步。'
    : (latestUser?.text ?? '继续处理当前事项');
}

export function continuedQuestionPanel(
  panel: PanelSpec | null,
  previousDraftId: string | undefined,
  task: Task,
): PanelSpec | null {
  const next = task.refs.filter((ref) => ref.kind === 'submission').at(-1);
  if (
    !previousDraftId ||
    panel?.kind !== 'submission' ||
    panel.id !== previousDraftId ||
    !next ||
    next.id === previousDraftId
  )
    return null;
  return {
    kind: 'submission',
    id: next.id,
    title: next.title,
    data: { view: 'edit' },
  };
}

export interface ClarificationQuestion {
  id: string;
  title: string;
  description?: string;
  options: { id: string; label: string; description?: string }[];
  multiple: boolean;
  status: 'pending' | 'answered' | 'deferred' | 'expired';
  answer?: { optionIds: string[]; text: string };
  draftId?: string;
  draftVersion?: number;
}

export interface QuestionAnswerInput {
  questionId: string;
  optionIds?: string[];
  text?: string;
  deferred?: boolean;
}

export function pendingQuestion(task: Task): ClarificationQuestion | undefined {
  return task.messages
    .filter((message) => message.question?.status === 'pending')
    .at(-1)?.question;
}

export function questionState(
  question: ClarificationQuestion,
  data: Record<string, any>,
): ClarificationQuestion['status'] {
  if (question.status !== 'pending') return question.status;
  if (question.draftId && question.draftVersion !== undefined) {
    const draft = data.submissions?.drafts?.[question.draftId];
    if (
      !draft ||
      draft.version !== question.draftVersion ||
      (draft.status && draft.status !== 'draft')
    )
      return 'expired';
  }
  return 'pending';
}

export function answerSummary(question: ClarificationQuestion): string {
  const answer = question.answer;
  if (!answer) return '';
  const selected = question.options
    .filter((option) => answer.optionIds.includes(option.id))
    .map((option) => option.label)
    .join('、');
  return [selected, answer.text?.trim()].filter(Boolean).join('；');
}

export function prepareQuestionAnswer(
  task: Task,
  input: QuestionAnswerInput,
  data: Record<string, any>,
): { message: string; answer: QuestionAnswerInput } {
  const question = pendingQuestion(task);
  if (!question || question.id !== input.questionId)
    throw new Error('问题已失效，请查看最新消息。');
  if (questionState(question, data) !== 'pending')
    throw new Error('草稿已变化，请根据最新信息重新确认。');
  if (input.deferred)
    return {
      message: '暂不处理',
      answer: {
        questionId: question.id,
        optionIds: [],
        text: '',
        deferred: true,
      },
    };
  const selected = new Set(input.optionIds ?? []);
  if (
    [...selected].some(
      (id) => !question.options.some((option) => option.id === id),
    )
  )
    throw new Error('选项已变化，请重新选择。');
  if (!question.multiple && selected.size > 1)
    throw new Error('这个问题只能选择一项。');
  const text = input.text?.trim() ?? '';
  if (!selected.size && !text) throw new Error('请选择一项或输入回答。');
  if (text.length > 2000) throw new Error('回答请控制在 2000 字以内。');
  const answer = {
    questionId: question.id,
    optionIds: question.options
      .filter((option) => selected.has(option.id))
      .map((option) => option.id),
    text,
  };
  return { message: answerSummary({ ...question, answer }), answer };
}
