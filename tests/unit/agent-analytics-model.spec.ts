import { describe, expect, it } from 'vitest';
import {
  analysisAmount,
  analysisRows,
  analysisScopeLabel,
  analysisSummary,
  buildAnalysisModel,
  change,
  normalizeAnalysisScope,
  parseAnalysisScope,
  previous,
  type AnalysisScope,
} from '../../apps/web/src/demos/agent-workspace/analytics-model.js';

describe('费用分析范围与事实', () => {
  it('集团10月金额、基期、差旅增额和预算均使用同口径数据', () => {
    const model = buildAnalysisModel();
    expect(model.total).toBe(486000);
    expect(model.count).toBe(15);
    expect(model.comparison).toMatchObject({ before: 428000, delta: 58000 });
    expect(model.comparison?.pct).toBeCloseTo(13.5514, 4);
    expect(model.budget).toBe(600000);
    expect(
      model.categories.map(({ name, value, previous, delta }) => ({
        name,
        value,
        previous,
        delta,
      })),
    ).toEqual([
      { name: '差旅', value: 264000, previous: 206000, delta: 58000 },
      { name: '招待', value: 108000, previous: 100000, delta: 8000 },
      { name: '办公', value: 64000, previous: 72000, delta: -8000 },
      { name: '其他', value: 50000, previous: 50000, delta: 0 },
    ]);
    expect(model.categories[0]?.share).toBeCloseTo(54.32099, 4);
    expect(
      model.departments.map(({ name, value }) => ({ name, value })),
    ).toEqual([
      { name: '销售', value: 218000 },
      { name: '研发', value: 120000 },
      { name: '行政', value: 80000 },
      { name: '运营', value: 68000 },
    ]);
    expect(model.summary).toMatch(/48\.60/);
    expect(model.summary).toMatch(/5\.80/);
    expect(model.summary).toMatch(/13\.6%/);
    expect(model.insights.comparison).toMatch(/差旅.*5\.80/);
    expect(model.insights.comparison).toMatch(/招待.*0\.80/);
    expect(model.insights.comparison).toMatch(/办公.*0\.80/);
    expect(model.findings).toHaveLength(3);
  });

  it('9月保留金额但不把缺失8月当作零基期', () => {
    const model = buildAnalysisModel({ month: '09' });
    expect(model.total).toBe(428000);
    expect(model.comparison).toBeNull();
    expect(model.budget).toBeNull();
    expect(
      model.categories.every(
        (row) => row.previous === null && row.delta === null,
      ),
    ).toBe(true);
    expect(
      model.departments.every(
        (row) => row.previous === null && row.delta === null,
      ),
    ).toBe(true);
    expect(model.summary).toMatch(/42\.80/);
    expect(model.insights.comparison).toMatch(/缺少.*8月/);
    expect(model.summary).not.toMatch(/增长100|增加42\.80/);
    expect(previous(model.scope)).toBeNull();
  });

  it('运营办公费用为零时没有虚假的占比、排名或除零结果', () => {
    const model = buildAnalysisModel({ dept: '运营', type: '办公' });
    expect(model).toMatchObject({
      total: 0,
      count: 0,
      budget: null,
      comparison: { before: 0, delta: 0, pct: null },
    });
    expect(model.categories).toEqual([
      { name: '办公', value: 0, previous: 0, delta: 0, share: 0 },
    ]);
    expect(model.departments).toEqual([
      { name: '运营', value: 0, previous: 0, delta: 0, share: 0 },
    ]);
    const narrative = JSON.stringify([
      model.summary,
      model.findings,
      model.insights,
    ]);
    expect(narrative).not.toMatch(/最大|最高|100(?:\.0)?%|NaN|Infinity/);
    expect(model.insights.comparison).toMatch(/基期为0|基期金额为0/);
    expect(model.findings).toHaveLength(3);
  });

  it('单类筛选中的部门增减可抵消，不能用净变化为分母算贡献率', () => {
    const model = buildAnalysisModel({ type: '其他' });
    expect(model).toMatchObject({
      total: 50000,
      count: 4,
      budget: null,
      comparison: { before: 50000, delta: 0, pct: 0 },
    });
    expect(model.categories).toEqual([
      { name: '其他', value: 50000, previous: 50000, delta: 0, share: 100 },
    ]);
    expect(model.departments.map((row) => row.delta)).toEqual([
      1000, -2000, 0, 1000,
    ]);
    expect(model.insights.structure).not.toMatch(/最大|最高/);
    expect(model.insights.comparison).toMatch(/持平/);
    expect(model.insights.comparison).toMatch(/抵消/);
    expect(model.insights.comparison).toMatch(/研发.*0\.20/);
    expect(JSON.stringify(model)).not.toMatch(/NaN|Infinity/);
  });

  it('部门与费用类型一起限定本期、比较期及图表分母', () => {
    const model = buildAnalysisModel({
      month: '10',
      dept: '销售',
      type: '办公',
    });
    expect(model).toMatchObject({
      total: 18000,
      count: 1,
      budget: null,
      comparison: { before: 23000, delta: -5000 },
    });
    expect(model.comparison?.pct).toBeCloseTo(-21.7391, 4);
    expect(model.categories).toEqual([
      { name: '办公', value: 18000, previous: 23000, delta: -5000, share: 100 },
    ]);
    expect(model.departments).toEqual([
      { name: '销售', value: 18000, previous: 23000, delta: -5000, share: 100 },
    ]);
    expect(model.summary).toMatch(/销售部/);
    expect(model.summary).toMatch(/减少0\.50/);
    expect(model.summary).not.toMatch(/48\.60|5\.80|差旅/);
  });

  it('生成结果保存独立范围，修改输入或返回明细不污染未来报表', () => {
    const scope: AnalysisScope = { month: '10', dept: '销售', type: '差旅' };
    const saved = buildAnalysisModel(scope);
    scope.month = '09';
    scope.dept = '运营';
    expect(saved.scope).toEqual({ month: '10', dept: '销售', type: '差旅' });
    expect(saved.total).toBe(140000);
    const rows = analysisRows(saved.scope);
    rows[0]!.amount = 1;
    expect(analysisAmount(saved.scope)).toBe(140000);
    expect(buildAnalysisModel(scope).total).toBe(25000);
  });

  it('范围兼容部门后缀与月份输入，非法维度回到有效默认值', () => {
    expect(
      normalizeAnalysisScope({
        month: '2026-09',
        dept: '销售部',
        type: '办公',
      }),
    ).toEqual({ month: '09', dept: '销售', type: '办公' });
    expect(
      normalizeAnalysisScope({ month: '13', dept: '不存在', type: '未知' }),
    ).toEqual({ month: '10', dept: '全部部门', type: null });
    expect(
      analysisScopeLabel({ month: '09', dept: '研发', type: '差旅' }),
    ).toBe('2026年9月 · 研发部 · 差旅');
    expect(analysisSummary()).toMatch(/5\.80/);
    expect(change({ month: '10', dept: '行政', type: '其他' })).toEqual({
      before: 6000,
      delta: 0,
      pct: 0,
    });
  });

  it('自然语言只覆盖显式维度，全集团和费用总额能清除对应筛选', () => {
    const base: AnalysisScope = { month: '10', dept: '销售', type: '差旅' };
    expect(parseAnalysisScope('2026年9月研发部办公', base)).toEqual({
      month: '09',
      dept: '研发',
      type: '办公',
    });
    expect(parseAnalysisScope('全集团费用总额', base)).toEqual({
      month: '10',
      dept: '全部部门',
      type: null,
    });
    expect(parseAnalysisScope('9月', base)).toEqual({
      month: '09',
      dept: '销售',
      type: '差旅',
    });
    expect(parseAnalysisScope('继续分析', base)).toEqual(base);
    expect(base).toEqual({ month: '10', dept: '销售', type: '差旅' });
  });
});
