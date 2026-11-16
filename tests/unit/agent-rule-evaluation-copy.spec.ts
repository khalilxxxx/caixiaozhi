import { describe, expect, it } from 'vitest';
import { evaluateWorkspaceRules } from '../../apps/web/src/demos/agent-workspace/RulesSubmission.js';
import {
  generateDemoRule,
  readRuleCenter,
} from '../../apps/web/src/demos/agent-workspace/rule-center-model.js';

describe('规则命中提示', () => {
  it('公司规则改为餐饮阈值后按阻断或提醒显示，保留个人提醒文案', () => {
    const base = readRuleCenter({}).rules.find((rule) => rule.id === 'R002')!;
    const doc: Parameters<typeof evaluateWorkspaceRules>[0] = {
      id: 'COPY-TEST',
      title: '餐饮报销',
      system: 'expense',
      kind: '费用报销',
      person: '林悦',
      department: '财务部',
      mealCents: 180000,
      period: '2026-11-16',
      attachment: true,
      version: 1,
      stage: '草稿',
      categories: ['meal'],
    };
    const blocking = generateDemoRule(
      '每张报销单的餐饮费用合计超过1500元时，阻断提单。',
      base,
    ).rule!;
    const blocked = evaluateWorkspaceRules(doc, [blocking], 'submit');
    expect(blocked.status).toBe('attention');
    expect(blocked.findings[0]?.rule.effect).toBe('block');
    expect(blocked.findings[0]?.detail).toContain('超出公司标准');
    expect(blocked.findings[0]?.detail).toContain('再提交');
    expect(blocked.findings[0]?.detail).not.toContain('个人提醒');

    const logic = '每张报销单的餐饮费用合计超过1500元时，审单时提醒本人。';
    const company = generateDemoRule(logic, base).rule!;
    const companyResult = evaluateWorkspaceRules(doc, [company]);
    expect(companyResult.findings[0]?.detail).toContain('公司提醒条件');
    expect(companyResult.findings[0]?.detail).not.toContain('再提交');

    const personal = generateDemoRule(logic).rule!;
    expect(evaluateWorkspaceRules(doc, [personal]).findings[0]?.detail).toBe(
      '达到个人提醒条件，不影响通用规则和正式审批。',
    );
    expect(
      evaluateWorkspaceRules({ ...doc, mealCents: 150000 }, [blocking], 'submit')
        .findings,
    ).toHaveLength(0);
  });
});
