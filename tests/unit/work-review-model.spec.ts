import { expect, it } from 'vitest';
import {
  type RuleReview,
  type WorkspaceRule,
  AUDIT_DOCUMENTS,
  INITIAL_RULES_SUBMISSION,
  getAuditSummary,
  readAuditReview,
  ruleSignature,
} from '../../apps/web/src/demos/agent-workspace/RulesSubmission.js';
import { summarizeWorkReview } from '../../apps/web/src/demos/agent-workspace/work-review-model.js';

it('区分已核实、未执行与不适用，用历史快照的原值解释分数区间', () => {
  const doc = AUDIT_DOCUMENTS[0]!;
  const base = INITIAL_RULES_SUBMISSION.rules.find(
    (rule) => rule.metric === 'hotelNight',
  )!;
  const [hotel, pass, pending, other] = [
    'hotel',
    'pass',
    'pending',
    'other',
  ].map((id) => ({
    ...base,
    id,
  })) as [WorkspaceRule, WorkspaceRule, WorkspaceRule, WorkspaceRule];
  const rules = [hotel, pass, pending, other];
  const review: RuleReview = {
    status: 'attention',
    applicable: [hotel, pass, pending],
    inapplicable: [other],
    passed: [pass],
    findings: [
      {
        rule: hotel,
        state: 'hit',
        actual: '78000',
        expected: hotel.description,
        detail: '旧版结果',
      },
      {
        rule: pending,
        state: 'unknown',
        actual: '尚未执行',
        expected: pending.description,
        detail: '尚无模型结果',
        executed: false,
      },
    ],
  };
  const state = {
    ...INITIAL_RULES_SUBMISSION,
    rules,
    reviewResults: {
      [doc.id]: {
        signature: ruleSignature(rules, 'review', doc.system),
        review,
        documentVersion: doc.version,
      },
    },
  };
  const result = summarizeWorkReview(doc, readAuditReview(doc, state));
  expect(result.score).toBe('33–67');
  expect(result.counts).toEqual({
    total: 4,
    executed: 2,
    hit: 1,
    pending: 1,
    passed: 1,
    inapplicable: 1,
  });
  expect(result.risks[0]?.detail).toContain('¥780.00/间夜');
  expect(result.risks[0]?.detail).toContain('¥600.00/间夜');
  const stale = summarizeWorkReview(
    doc,
    readAuditReview(doc, { ...state, rules: rules.slice(1) }),
  );
  expect(stale).toMatchObject({
    score: null,
    risks: [],
    stale: true,
    counts: { executed: 0, passed: 0, hit: 0 },
  });
});

it('无适用规则计入未发现异常，单据保留零执行与空评分', () => {
  const doc = AUDIT_DOCUMENTS[0]!;
  const review: RuleReview = {
    status: 'clear',
    applicable: [],
    inapplicable: [],
    findings: [],
    passed: [],
  };
  const state = {
    ...INITIAL_RULES_SUBMISSION,
    rules: [],
    reviewResults: {
      [doc.id]: { signature: '[]', documentVersion: doc.version, review },
    },
  };
  expect(
    getAuditSummary({ auditDocuments: [doc], rulesSubmission: state }).data,
  ).toMatchObject({ clear: 1, attention: 0, unknown: 0 });
  expect(summarizeWorkReview(doc, readAuditReview(doc, state))).toMatchObject({
    score: null,
    counts: { executed: 0, passed: 0 },
  });
});
