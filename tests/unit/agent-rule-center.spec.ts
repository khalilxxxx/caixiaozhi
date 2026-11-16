import { describe, expect, it, vi } from 'vitest';
import {
  generateDemoRule,
  isDraftCurrent,
  publishDemoRule,
  readRuleCenter,
  RULE_CENTER_KEY,
  RULE_EXAMPLES,
  toWorkspaceRule,
  type DemoRuleDraft,
} from '../../apps/web/src/demos/agent-workspace/rule-center-model.js';

describe('规则中心本地规则模型', () => {
  it('迁移现有规则的金额分值、停用状态和版本，并补充七条示例的只读信息', () => {
    const initial = readRuleCenter({});
    expect(initial.rules).toHaveLength(7);
    const hotel = initial.rules.find((rule) => rule.id === 'R002')!;
    expect(hotel.thresholdMinor).toBe(60000);
    expect(hotel.version).toBe(3);
    expect(hotel.category).toBe('lodging');
    expect(initial.rules.find((rule) => rule.id === 'P002')?.enabled).toBe(
      false,
    );

    const rules = initial.rules
      .map(toWorkspaceRule)
      .map((rule) =>
        rule.id === 'R002'
          ? { ...rule, thresholdMinor: 71234, enabled: false, version: 8 }
          : rule,
      );
    const migrated = readRuleCenter({ rulesSubmission: { rules } });
    const retained = migrated.rules.find((rule) => rule.id === 'R002')!;
    expect(retained).toMatchObject({
      thresholdMinor: 71234,
      enabled: false,
      version: 8,
    });
    expect(retained.logic).toContain('712.34');
    expect(retained.evidence.length).toBeGreaterThan(0);
    expect(retained.applicability.join('')).not.toContain('712.34');
    expect(retained.stage).toBe('published');
  });

  it('已有本地规则中心时优先恢复其草稿和编辑位置', () => {
    const state = { ...readRuleCenter({}), editingId: 'R002' };
    expect(readRuleCenter({ [RULE_CENTER_KEY]: state })).toBe(state);
  });

  it('旧附件缓存仅刷新已发布和生成草稿的缺失说明，保留草稿文字及历史', () => {
    const initial = readRuleCenter({});
    const legacyMissing =
      '必要字段或核对依据缺失时标记为“待核实”，列明缺失内容；补充后重新检查，不直接判为通过。';
    const attachment = initial.rules.find((rule) => rule.id === 'R004')!;
    const generated = generateDemoRule(
      '报销单缺少对应费用凭证时，审单时提醒本人。',
      attachment,
    ).rule!;
    const state = {
      ...initial,
      rules: initial.rules.map((rule) =>
        rule.id === 'R004' ? { ...rule, missing: legacyMissing } : rule,
      ),
      editingId: 'R004',
      drafts: {
        R004: {
          text: '尚未重新生成的草稿文字',
          generated: { ...generated, missing: legacyMissing },
          generatedFrom: generated.logic,
          savedAt: '2026/11/16 20:15',
          baseVersion: 1,
        },
      },
    };
    const before = structuredClone(state);
    const restored = readRuleCenter({ [RULE_CENTER_KEY]: state });
    const restoredRule = restored.rules.find((rule) => rule.id === 'R004')!;
    const restoredDraft = restored.drafts.R004!;
    expect(restoredRule.missing).toContain('确认未附必需材料');
    expect(restoredRule.missing).toContain('阻断提单');
    expect(restoredDraft.generated?.missing).toContain('触发提醒');
    expect(restoredDraft.generated?.missing).toContain('附件信息尚未取得');
    expect({ ...restoredRule, missing: legacyMissing }).toEqual(
      before.rules.find((rule) => rule.id === 'R004'),
    );
    expect({
      ...restoredDraft,
      generated: { ...restoredDraft.generated, missing: legacyMissing },
    }).toEqual(before.drafts.R004);
    expect(restored.editingId).toBe('R004');
    expect(restored.rules[0]).toBe(state.rules[0]);
    expect(state).toEqual(before);
    expect(readRuleCenter({ [RULE_CENTER_KEY]: restored })).toBe(restored);
  });

  it.each([
    '每张报销单的餐饮费用合计超过1500元时，审单时提醒本人，但销售部除外。',
    '北京住宿超过600元时提醒，上海超过800元时阻断。',
    '发票金额超过100元或行程不一致时提醒本人。',
    '每张报销单的餐饮费用合计超过1500美元时，审单时提醒本人。',
    '每张报销单的餐饮费用合计超过1.505元时，审单时提醒本人。',
  ])('不吞掉未支持的条件：%s', (text) => {
    const result = generateDemoRule(text);
    expect(result.rule).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('新建示例均生成个人提醒，金额以分保存并区分逐项与每单合计', () => {
    for (const example of RULE_EXAMPLES) {
      expect(generateDemoRule(example.text).rule).toMatchObject({
        origin: 'personal',
        effect: 'warn',
      });
    }
    const meal = generateDemoRule(
      '每张报销单的餐饮费用合计超过1500.25元时，审单时提醒本人。',
    ).rule!;
    expect(meal.thresholdMinor).toBe(150025);
    expect(meal.output).toContain('每张报销单');
    expect(meal.output).toContain('合计');
    const hotel = generateDemoRule(
      '住宿费用每间夜超过600.50元时，审单时提醒本人。',
    ).rule!;
    expect(hotel.thresholdMinor).toBe(60050);
    expect(hotel.output).toContain('每项住宿');
    expect(hotel.evidence.map((entry) => entry.name).join('')).toContain(
      '间夜',
    );
    expect(meal.id).not.toBe(hotel.id);
  });

  it('个人规则不能通过编辑业务逻辑升级为公司阻断', () => {
    const personal = readRuleCenter({}).rules.find(
      (rule) => rule.id === 'P001',
    )!;
    const text = '每张报销单的餐饮费用合计超过1500元时，阻断提单。';
    expect(generateDemoRule(text).error).toContain('个人');
    expect(generateDemoRule(text, personal).error).toContain('个人');
    expect(generateDemoRule(text, personal).rule).toBeUndefined();
  });

  it('编辑公司住宿规则保留身份、版本和停用状态，并支持数字修改', () => {
    const base = {
      ...readRuleCenter({}).rules.find((rule) => rule.id === 'R002')!,
      enabled: false,
    };
    const edited = generateDemoRule(
      '住宿费用每间夜超过650元时，阻断提单。',
      base,
    ).rule!;
    expect(edited).toMatchObject({
      id: 'R002',
      origin: 'builtin',
      effect: 'block',
      thresholdMinor: 65000,
      enabled: false,
      version: 3,
    });
    expect(edited.revisions).toEqual(base.revisions);
    expect(edited.stage).toBe('draft');
  });

  it('迁移的全部规则可使用当前业务逻辑重新生成，天数不按金额换算', () => {
    for (const rule of readRuleCenter({}).rules) {
      const result = generateDemoRule(rule.logic, rule);
      expect(result.error).toBeUndefined();
      expect(result.rule?.metric).toBe(rule.metric);
    }
    const base = readRuleCenter({}).rules.find((rule) => rule.id === 'P002')!;
    expect(
      generateDemoRule(base.logic.replace('5天', '7天'), base).rule
        ?.thresholdDays,
    ).toBe(7);
  });

  it('公司规则从审单提醒改回阻断后恢复提单和审单范围', () => {
    const base = readRuleCenter({}).rules.find((rule) => rule.id === 'R002')!;
    const reminder = publishDemoRule(
      generateDemoRule('住宿费用每间夜超过600元时，审单时提醒本人。', base)
        .rule!,
      base,
    );
    expect(reminder).toMatchObject({ effect: 'warn', scope: 'review' });
    const restored = publishDemoRule(
      generateDemoRule('住宿费用每间夜超过600元时，阻断提单。', reminder).rule!,
      reminder,
    );
    expect(toWorkspaceRule(restored)).toMatchObject({
      effect: 'block',
      scope: 'both',
      origin: 'builtin',
    });
  });

  it('发布时间固定使用北京时间而不随浏览器所在时区变化', () => {
    vi.useFakeTimers();
    vi.stubEnv('TZ', 'UTC');
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    try {
      const generated = generateDemoRule(RULE_EXAMPLES[0]!.text).rule!;
      const published = publishDemoRule(generated);
      expect(published.updatedAt).toBe('2026/11/16 20:00');
      expect(published.revisions.at(-1)?.at).toBe('2026/11/16 20:00');
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('发布追加版本且历史快照不受后续修改影响', () => {
    const previous = readRuleCenter({}).rules.find(
      (rule) => rule.id === 'R002',
    )!;
    const before = structuredClone(previous);
    const generated = generateDemoRule(
      previous.logic.replace('600元', '700元'),
      previous,
    ).rule!;
    const published = publishDemoRule(generated, previous);
    expect(published.version).toBe(4);
    expect(published.revisions.at(-1)?.logic).toContain('700元');
    expect(published.revisions.at(-1)?.version).toBe(4);
    expect(published.stage).toBe('published');
    expect(published.updatedAt).toBeTruthy();
    expect(previous).toEqual(before);
    published.revisions[0]!.logic = '修改快照';
    expect(previous).toEqual(before);
    expect(
      publishDemoRule(generateDemoRule(RULE_EXAMPLES[0]!.text).rule!).version,
    ).toBe(1);
  });

  it('输入修改后拒绝使用旧生成结果，未生成不能保存', () => {
    const text = RULE_EXAMPLES[1]!.text;
    const draft: DemoRuleDraft = {
      text,
      generated: generateDemoRule(text).rule!,
      generatedFrom: text,
      savedAt: '',
      baseVersion: null,
    };
    expect(isDraftCurrent(draft)).toBe(true);
    expect(isDraftCurrent({ ...draft, text: ` ${text} ` })).toBe(true);
    expect(
      isDraftCurrent({ ...draft, text: text.replace('1500', '1600') }),
    ).toBe(false);
    expect(isDraftCurrent({ ...draft, generated: null })).toBe(false);
  });

  it('向预审输出仅包含旧规则字段，不携带草稿和元数据', () => {
    const rule = readRuleCenter({}).rules.find((entry) => entry.id === 'R002')!;
    expect(toWorkspaceRule(rule)).toEqual({
      id: 'R002',
      name: '住宿费用标准',
      system: 'expense',
      origin: 'builtin',
      scope: 'both',
      metric: 'hotelNight',
      thresholdMinor: 60000,
      effect: 'block',
      enabled: true,
      version: 3,
      description: '普通员工差旅住宿费用不超过600元/间夜。',
    });
  });
});
