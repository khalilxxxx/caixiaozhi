import { describe, expect, it } from 'vitest';
import type { SseEvent } from '@caixiaozhi/contracts';
import {
  createRunEventState,
  mergeRunEvent,
} from '../../packages/assistant/src/events.js';
const event = (
  seq: number,
  type: SseEvent['type'],
  payload: unknown,
): SseEvent => ({
  run_id: 'run-a',
  seq,
  type,
  payload,
  occurred_at: new Date().toISOString(),
});
describe('SSE事件归并', () => {
  it('乱序缓存后按连续seq应用，重放不重复文本，final覆盖增量', () => {
    let state = createRunEventState('run-a');
    state = mergeRunEvent(state, event(2, 'assistant.delta', { text: '好' }));
    expect(state.text).toBe('');
    state = mergeRunEvent(state, event(1, 'assistant.delta', { text: '你' }));
    expect(state.text).toBe('你好');
    state = mergeRunEvent(state, event(2, 'assistant.delta', { text: '好' }));
    expect(state.text).toBe('你好');
    state = mergeRunEvent(
      state,
      event(3, 'assistant.message', { id: 'message-a', text: '完整结果' }),
    );
    expect(state.text).toBe('完整结果');
    expect(state.through_seq).toBe(3);
    expect(
      mergeRunEvent(state, {
        ...event(4, 'assistant.delta', { text: 'bad' }),
        run_id: 'other',
      }),
    ).toBe(state);
  });
  it('card按revision去重，缺口缓存超过100需读快照', () => {
    let state = createRunEventState('run-a');
    state = mergeRunEvent(
      state,
      event(1, 'card.upsert', { id: 'card-a', revision: 2 }),
    );
    state = mergeRunEvent(
      state,
      event(2, 'card.upsert', { id: 'card-a', revision: 1 }),
    );
    expect(state.cards.get('card-a')?.revision).toBe(2);
    for (let i = 5; i < 107; i++)
      state = mergeRunEvent(state, event(i, 'assistant.delta', { text: 'x' }));
    expect(state.recovery_required).toBe(true);
  });
});
