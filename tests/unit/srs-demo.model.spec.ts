import { describe, expect, it } from 'vitest';
import {
  evaluate,
  initialDocs,
  initialDraft,
  initialRules,
  rulesSignature,
  summary,
  type Rule,
} from '../../apps/web/src/demos/srs-review/model.js';

describe('SRS local prototype business cases', () => {
  it('keeps uncertain checks separate from violations and counts the full batch', () => {
    expect(summary(initialDocs, initialRules)).toEqual({
      attention: 3,
      unknown: 1,
      clear: 4,
    });
    const waiting = evaluate(initialDocs[2]!, initialRules);
    expect(waiting.status).toBe('unknown');
    expect(waiting.findings).toHaveLength(1);
    expect(waiting.findings[0]?.state).toBe('unknown');
  });
  it('applies the correct system rules to an OA document with no amount', () => {
    const leave = initialDocs[6]!;
    expect(leave.amount).toBeUndefined();
    expect(evaluate(leave, initialRules).applicable.map((r) => r.id)).toEqual([
      'R005',
    ]);
  });
  it('blocks over-standard submission, then permits an exact-limit draft', () => {
    const first = evaluate(initialDraft, initialRules, 'submit');
    expect(first.findings.some((f) => f.rule.effect === 'block')).toBe(true);
    expect(first.findings[0]?.detail).toContain('360.00');
    const adjusted = evaluate(
      { ...initialDraft, hotelNight: 600, amount: 2900 },
      initialRules,
      'submit',
    );
    expect(adjusted.status).toBe('clear');
    expect(adjusted.findings).toHaveLength(0);
  });
  it('does not apply a reviewer reminder to submission or override mandatory checks', () => {
    const largeMeal = initialDocs[3]!;
    expect(evaluate(largeMeal, initialRules).findings[0]?.rule.origin).toBe(
      'personal',
    );
    expect(evaluate(largeMeal, initialRules, 'submit').findings).toHaveLength(
      0,
    );
    const remindersOff = initialRules.map((r) =>
      r.origin === 'personal' ? { ...r, enabled: false } : r,
    );
    expect(
      evaluate(initialDocs[0]!, remindersOff).findings.some(
        (f) => f.rule.id === 'R002',
      ),
    ).toBe(true);
  });
  it('uses strict greater-than semantics and keeps personal reminders nonblocking', () => {
    const rule: Rule = { ...initialRules[5]!, scope: 'both', threshold: 1500 };
    for (const [meal, hits] of [
      [1499.99, 0],
      [1500, 0],
      [1500.01, 1],
    ]) {
      const result = evaluate(
        { ...initialDraft, hotelNight: 600, meal },
        [rule],
        'submit',
      );
      expect(result.findings).toHaveLength(hits!);
      expect(result.findings.every((f) => f.rule.effect === 'warn')).toBe(true);
    }
  });
  it('saving inactive drafts does not invalidate a previous review', () => {
    const draft: Rule = {
      ...initialRules[5]!,
      id: 'new-draft',
      enabled: false,
      threshold: 2000,
    };
    expect(rulesSignature([...initialRules, draft], 'review')).toBe(
      rulesSignature(initialRules, 'review'),
    );
  });
  it('invalidates only the affected active system and execution scenario', () => {
    const changed = initialRules.map((r) =>
      r.id === 'P001' ? { ...r, threshold: 2000, version: 2 } : r,
    );
    expect(rulesSignature(changed, 'review', 'expense')).not.toBe(
      rulesSignature(initialRules, 'review', 'expense'),
    );
    expect(rulesSignature(changed, 'submit', 'expense')).toBe(
      rulesSignature(initialRules, 'submit', 'expense'),
    );
    expect(rulesSignature(changed, 'review', 'oa')).toBe(
      rulesSignature(initialRules, 'review', 'oa'),
    );
  });
  it('enabling an OA rule affects OA only', () => {
    const rules = initialRules.map((r) =>
      r.id === 'P002' ? { ...r, enabled: true } : r,
    );
    expect(
      evaluate(initialDocs[7]!, rules).findings.map((f) => f.rule.id),
    ).toEqual(['P002']);
    expect(evaluate(initialDocs[0]!, rules)).toEqual(
      evaluate(initialDocs[0]!, initialRules),
    );
  });
});
