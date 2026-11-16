import { describe, expect, it } from 'vitest';
import {
  homeExamples,
  selectPromptExamples,
} from '../../apps/web/src/demos/agent-workspace/prompt-model';

describe('home prompt examples', () => {
  it('returns three distinct suggestions from the available examples', () => {
    const selected = selectPromptExamples([], () => 0.5);
    expect(selected).toHaveLength(3);
    expect(new Set(selected).size).toBe(3);
    expect(selected.every((text) => homeExamples.includes(text))).toBe(true);
  });

  it('changes the complete group without modifying the existing suggestions', () => {
    const previous = homeExamples.slice(0, 3);
    const snapshot = [...previous];
    const selected = selectPromptExamples(previous, () => 0);
    expect(selected).toHaveLength(3);
    expect(selected.some((text) => previous.includes(text))).toBe(false);
    expect(previous).toEqual(snapshot);
  });

  it('uses the random source to vary the initial suggestions', () => {
    expect(selectPromptExamples([], () => 0)).not.toEqual(
      selectPromptExamples([], () => 0.99),
    );
  });
});
