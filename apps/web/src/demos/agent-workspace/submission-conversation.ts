import type { ChatMessage, ContextRef, Task } from './workspace';
import { getDraftType, type DraftId, type DraftType } from './submission-model';
import { resolveDraftId } from './submission-state';

export function conversationDraft(
  text: string,
  task: Task,
  refs: ContextRef[],
): DraftId {
  const intent = /^\s*(?:请|帮我)?\s*(?:单据)?事由\s*(?:改|调整|设|为|是)/.test(
    text,
  )
    ? ''
    : text;
  const ref = refs.filter((item) => item.kind === 'submission').at(-1);
  const previous = task.messages
    .flatMap((message) => message.cards ?? [])
    .filter((card) => card.kind === 'submission')
    .at(-1);
  const context = ref ?? previous;
  const requested: DraftType | undefined =
    /个人.*报销|日常.*报销|非差旅.*报销/.test(intent)
      ? 'personal'
      : /报销/.test(intent)
        ? 'expense'
        : /差旅申请|出差申请|申请.*出差|申请差旅/.test(intent)
          ? 'travel'
          : undefined;
  if (requested) {
    const currentId = context?.id;
    if (
      currentId &&
      getDraftType(currentId) === requested &&
      !/新建|新增|另[建开]|再[建开]|新[的单]/.test(intent)
    )
      return currentId;
    return requested;
  }
  if (context) return resolveDraftId(context.id);
  return /出差|返程|往返|从.+(?:去|到|前往)/.test(text) ? 'travel' : 'expense';
}

export function isSubmissionFollowUp(
  text: string,
  task: Task,
  refs: ContextRef[],
): boolean {
  const context =
    task.type === 'submission' || refs.some((ref) => ref.kind === 'submission');
  return (
    context &&
    /修改|改为|改成|改到|调整|事由|返程|往返|补充|当前草稿|这张单|继续填|提交|保存/.test(
      text,
    )
  );
}

export function visibleMessageCards(message: ChatMessage) {
  return (message.cards ?? [])
    .map((card, index) => ({ card, index }))
    .filter(
      ({ card }) =>
        message.submissionPhase !== 'collecting' || card.kind !== 'submission',
    );
}

export function latestSubmissionCards(task: Task): Set<string> {
  const latest = new Map<DraftId, string>();
  task.messages.forEach((message) =>
    visibleMessageCards(message).forEach(({ card, index }) => {
      if (card.kind === 'submission')
        latest.set(resolveDraftId(card.id), `${message.id}:${index}`);
    }),
  );
  return new Set(latest.values());
}
