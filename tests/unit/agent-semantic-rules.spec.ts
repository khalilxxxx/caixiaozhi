import { describe, expect, it } from 'vitest';
import {
  INITIAL_RULES_SUBMISSION,
  evaluateWorkspaceRules,
  getAuditSummary,
  readAuditReview,
  ruleSignature,
  type ReviewDoc,
  type RuleReview,
  type WorkspaceRule,
} from '../../apps/web/src/demos/agent-workspace/RulesSubmission.js';
import {
  applicableRules,
  checkSignature,
  hasBlockingIssues,
} from '../../apps/web/src/demos/agent-workspace/SubmissionWorkspace.js';
import {
  readRuleCenter,
  toWorkspaceRule,
} from '../../apps/web/src/demos/agent-workspace/rule-center-model.js';
import type { SubmissionDraft } from '../../apps/web/src/demos/agent-workspace/submission-model.js';

const semantic: WorkspaceRule = {
  id: 'SEM-TRAVEL-001',
  name: '差旅事由明确性',
  system: 'oa',
  origin: 'personal',
  scope: 'both',
  metric: 'semantic',
  effect: 'warn',
  enabled: true,
  version: 1,
  description: '核对差旅事由是否明确',
  instruction: '依据差旅事由判断是否说明业务目的，证据不足时待核实。',
  requiredFields: ['purpose'],
  documentTypes: ['travel'],
};
const doc: ReviewDoc = {
  id: 'travel-unique',
  title: '差旅申请',
  kind: '差旅申请',
  documentType: 'travel',
  system: 'oa',
  person: '林悦',
  department: '财务部',
  attachment: true,
  period: '2026-11-17',
  version: 2,
  stage: '草稿',
  categories: [],
};
const clearReview: RuleReview = {
  status: 'clear',
  findings: [],
  passed: [semantic],
  applicable: [semantic],
  inapplicable: [],
  engine: 'agno-semantic',
  model: 'configured-model',
  evaluations: [
    {
      ruleId: semantic.id,
      state: 'NOT_MATCHED',
      reason: '事由已明确业务目的',
      evidence: [{ path: 'purpose', quote: '赴杭州开展客户项目验收' }],
    },
  ],
};
const state = {
  ...INITIAL_RULES_SUBMISSION,
  rules: [semantic],
  reviewedRules: [semantic],
};

describe('语义规则前端契约', () => {
  it('完整投影语义字段，并按后端字段顺序计算规则签名', () => {
    const parsed = readRuleCenter({ rulesSubmission: { rules: [semantic] } })
      .rules[0]!;
    expect(parsed.logic).toBe(semantic.instruction);
    expect(toWorkspaceRule(parsed)).toEqual(semantic);
    expect(ruleSignature([semantic], 'review', 'oa')).toBe(
      JSON.stringify([
        {
          id: semantic.id,
          name: semantic.name,
          system: semantic.system,
          origin: semantic.origin,
          scope: semantic.scope,
          metric: semantic.metric,
          effect: semantic.effect,
          enabled: semantic.enabled,
          version: semantic.version,
          description: semantic.description,
          instruction: semantic.instruction,
          requiredFields: semantic.requiredFields,
          documentTypes: semantic.documentTypes,
        },
      ]),
    );
    for (const change of [
      { instruction: '改为核对私人活动' },
      { requiredFields: ['legs'] },
      { documentTypes: ['expense'] as const },
    ]) {
      expect(
        ruleSignature(
          [
            {
              ...semantic,
              ...change,
              documentTypes: change.documentTypes
                ? [...change.documentTypes]
                : semantic.documentTypes,
            },
          ],
          'review',
          'oa',
        ),
      ).not.toBe(ruleSignature([semantic], 'review', 'oa'));
    }
  });

  it('混合大小写规则 ID 按 Python ASCII 码点顺序签名并识别服务端结果', () => {
    const rules = ['personal-001', 'SEM-TRAVEL-001', 'R002'].map((id) => ({
      ...semantic,
      id,
    }));
    // Python sorted 的顺序：大写 R、SEM 在小写 personal 之前。
    const serverSignature = JSON.stringify(
      ['R002', 'SEM-TRAVEL-001', 'personal-001'].map((id) => ({
        ...semantic,
        id,
      })),
    );
    expect(ruleSignature(rules, 'review', 'oa')).toBe(serverSignature);
    expect(checkSignature('travel-unique', rules)).toBe(serverSignature);
    expect(
      readAuditReview(doc, {
        ...state,
        rules,
        reviewResults: {
          [doc.id]: {
            documentVersion: doc.version,
            signature: serverSignature,
            review: clearReview,
          },
        },
      }),
    ).toMatchObject({ checked: true, stale: false, review: clearReview });
    expect(rules.map((rule) => rule.id)).toEqual([
      'personal-001',
      'SEM-TRAVEL-001',
      'R002',
    ]);
  });

  it('没有服务结果时绝不将语义规则本地判为通过', () => {
    const review = evaluateWorkspaceRules(doc, [semantic]);
    expect(review.status).toBe('unknown');
    expect(review.passed).toEqual([]);
    expect(review.findings[0]).toMatchObject({
      state: 'unknown',
      evidence: [],
    });
    expect(review.findings[0]?.detail).toContain('服务端');
  });

  it('按单据类型筛选且保留没有 documentTypes 的旧规则', () => {
    const legacy = {
      ...semantic,
      id: 'legacy-days',
      metric: 'days' as const,
      documentTypes: undefined,
      thresholdDays: 5,
    };
    const expense = {
      ...semantic,
      id: 'expense-rule',
      system: 'expense' as const,
      documentTypes: ['expense' as const],
    };
    const personal = {
      ...expense,
      id: 'personal-rule',
      documentTypes: ['personal' as const],
    };
    expect(
      applicableRules('travel-unique', [semantic, legacy, expense]).map(
        (rule) => rule.id,
      ),
    ).toEqual([semantic.id, legacy.id]);
    expect(
      applicableRules('personal-unique', [expense, personal]).map(
        (rule) => rule.id,
      ),
    ).toEqual([personal.id]);
    expect(
      evaluateWorkspaceRules({ ...doc, documentType: 'expense' }, [semantic]),
    ).toMatchObject({ applicable: [], inapplicable: [semantic] });
    const draft = { id: 'opaque-unique-id', type: 'travel' } as SubmissionDraft;
    expect(checkSignature(draft, [semantic])).toBe(
      ruleSignature([semantic], 'submit', 'oa'),
    );
  });

  it('只有单据版本及规则签名同时匹配才读取服务端通过结果', () => {
    const saved = {
      documentVersion: 2,
      signature: ruleSignature([semantic], 'review', 'oa'),
      review: clearReview,
    };
    const checked = { ...state, reviewResults: { [doc.id]: saved } };
    expect(readAuditReview(doc, checked)).toMatchObject({
      checked: true,
      stale: false,
      review: clearReview,
    });
    expect(readAuditReview(doc, state)).toMatchObject({
      checked: false,
      stale: false,
      review: { status: 'unknown', passed: [] },
    });
    expect(readAuditReview({ ...doc, version: 3 }, checked)).toMatchObject({
      checked: false,
      stale: true,
      review: { status: 'unknown', passed: [] },
    });
    expect(
      readAuditReview(doc, {
        ...checked,
        rules: [{ ...semantic, instruction: '新的逻辑' }],
      }),
    ).toMatchObject({
      checked: false,
      stale: true,
      review: { status: 'unknown', passed: [] },
    });
    expect(
      getAuditSummary({ rulesSubmission: state, auditDocuments: [doc] }).data,
    ).toMatchObject({ unknown: 1, clear: 0 });
    expect(
      getAuditSummary({ rulesSubmission: checked, auditDocuments: [doc] }).data,
    ).toMatchObject({ unknown: 0, clear: 1 });
  });

  it('语义提醒待核实不产生隐式阻断，确定性缺数和阻断规则仍阻断', () => {
    const review = evaluateWorkspaceRules(doc, [semantic]);
    const check = {
      version: 2,
      signature: '',
      checkedAt: '',
      issues: [],
      review,
    };
    expect(hasBlockingIssues(check)).toBe(false);
    expect(
      hasBlockingIssues({
        ...check,
        review: {
          ...review,
          findings: [
            { ...review.findings[0]!, rule: { ...semantic, effect: 'block' } },
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasBlockingIssues({
        ...check,
        review: {
          ...review,
          findings: [
            { ...review.findings[0]!, rule: { ...semantic, metric: 'days' } },
          ],
        },
      }),
    ).toBe(true);
    expect(
      hasBlockingIssues({
        ...check,
        issues: [{ path: 'purpose', message: '请填写事由' }],
      }),
    ).toBe(true);
  });
});
