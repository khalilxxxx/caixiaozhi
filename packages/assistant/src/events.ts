import type { AgentCard, SseEvent } from '@caixiaozhi/contracts';
export type RunEventState = {
  run_id: string;
  through_seq: number;
  buffer: Map<number, SseEvent>;
  text: string;
  message_id: string | null;
  cards: Map<string, AgentCard>;
  status: string | null;
  recovery_required: boolean;
};
export function createRunEventState(
  runId: string,
  throughSeq = 0,
): RunEventState {
  return {
    run_id: runId,
    through_seq: throughSeq,
    buffer: new Map(),
    text: '',
    message_id: null,
    cards: new Map(),
    status: null,
    recovery_required: false,
  };
}
/** 按单run连续seq应用；最终文本替换增量，同card只接受更大revision。 */
export function mergeRunEvent(
  state: RunEventState,
  event: SseEvent,
): RunEventState {
  if (event.run_id !== state.run_id || event.seq <= state.through_seq)
    return state;
  const next = {
    ...state,
    buffer: new Map(state.buffer),
    cards: new Map(state.cards),
  };
  next.buffer.set(event.seq, event);
  if (next.buffer.size > 100) {
    next.recovery_required = true;
    return next;
  }
  for (;;) {
    const current = next.buffer.get(next.through_seq + 1);
    if (!current) break;
    next.buffer.delete(current.seq);
    next.through_seq = current.seq;
    const payload = current.payload as Record<string, any>;
    if (current.type === 'assistant.delta' && typeof payload.text === 'string')
      next.text += payload.text;
    if (
      current.type === 'assistant.message' &&
      typeof payload.text === 'string'
    ) {
      next.text = payload.text;
      next.message_id = String(payload.id ?? payload.message_id ?? '');
    }
    if (current.type === 'run.status') next.status = String(payload.status);
    if (current.type === 'card.upsert') {
      const card = payload as AgentCard;
      const old = next.cards.get(card.id);
      if (!old || card.revision > old.revision) next.cards.set(card.id, card);
    }
  }
  return next;
}
