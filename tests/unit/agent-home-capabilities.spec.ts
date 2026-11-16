import { describe, expect, it } from 'vitest';
import {
  capabilities,
  capabilityExamples,
} from '../../apps/web/src/demos/agent-workspace/capability-model';
import { selectPromptExamples } from '../../apps/web/src/demos/agent-workspace/prompt-model';

describe('home capability examples', () => {
  it('keeps the existing generic examples when no capability is selected', () => {
    const previous = selectPromptExamples([], () => 0);
    expect(capabilityExamples(null, previous, () => 0.5)).toEqual(
      selectPromptExamples(previous, () => 0.5),
    );
    expect(capabilityExamples(undefined, [], () => 0)).toEqual(
      selectPromptExamples([], () => 0),
    );
  });

  it.each(capabilities)('samples three distinct examples for $label', (capability) => {
    const selected = capabilityExamples(capability.id, [], () => 0.5);
    expect(selected).toHaveLength(3);
    expect(new Set(selected).size).toBe(3);
    expect(selected.every((text) => capability.examples.includes(text))).toBe(true);
  });

  it.each(capabilities)('refreshes the whole group for $label without mutating it', (capability) => {
    const previous = capabilityExamples(capability.id, [], () => 0);
    const snapshot = [...previous];
    const selected = capabilityExamples(capability.id, previous, () => 0.9);
    expect(selected).toHaveLength(3);
    expect(selected.some((text) => previous.includes(text))).toBe(false);
    expect(previous).toEqual(snapshot);
  });

  it('uses the random source to vary the first group', () => {
    expect(capabilityExamples('submission', [], () => 0)).not.toEqual(
      capabilityExamples('submission', [], () => 0.99),
    );
  });
});
