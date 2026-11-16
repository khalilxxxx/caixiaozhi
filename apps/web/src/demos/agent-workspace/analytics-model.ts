export interface AnalysisScope {
  month: '09' | '10';
  dept: string;
  type: string | null;
}

export const DEFAULT_ANALYSIS_SCOPE: AnalysisScope = {
  month: '10',
  dept: '全部部门',
  type: null,
};
export const departments = ['销售', '研发', '行政', '运营'];
export const categories = ['差旅', '招待', '办公', '其他'];

// 固定案例的两个月矩阵：行是部门，列是费用类型，单位为人民币元。
const matrix: Record<string, number[][]> = {
  '10': [
    [140000, 50000, 18000, 10000],
    [60000, 10000, 30000, 20000],
    [30000, 28000, 16000, 6000],
    [34000, 20000, 0, 14000],
  ],
  '09': [
    [110000, 48000, 23000, 9000],
    [45000, 8000, 35000, 22000],
    [26000, 24000, 14000, 6000],
    [25000, 20000, 0, 13000],
  ],
};

export interface AnalysisRow {
  id: string;
  month: string;
  dept: string;
  type: string;
  amount: number;
  date: string;
}

const records: AnalysisRow[] = Object.entries(matrix).flatMap(([month, rows]) =>
  rows.flatMap((row, d) =>
    row
      .map((amount, c) => ({
        id: `BX2026${month}${String(d * 4 + c + 1).padStart(3, '0')}`,
        month,
        dept: departments[d]!,
        type: categories[c]!,
        amount,
        date: `2026-${month}-${String(5 + d * 5 + c).padStart(2, '0')}`,
      }))
      .filter((row) => row.amount > 0),
  ),
);

export const wan = (value: number) => (value / 10000).toFixed(2);
export const yuan = (value: number) =>
  value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function normalizeAnalysisScope(
  input?: Partial<AnalysisScope> | Record<string, unknown>,
): AnalysisScope {
  const rawMonth = String(input?.month || '10').slice(-2);
  const rawDept = String(input?.dept || '全部部门').replace(/部$/, '');
  return {
    month: Number(rawMonth) === 9 ? '09' : '10',
    dept: departments.includes(rawDept) ? rawDept : '全部部门',
    type: categories.includes(String(input?.type)) ? String(input?.type) : null,
  };
}

export function analysisScopeLabel(input?: Partial<AnalysisScope>) {
  const scope = normalizeAnalysisScope(input);
  return `2026年${Number(scope.month)}月 · ${scope.dept === '全部部门' ? '全集团' : scope.dept + '部'}${scope.type ? ' · ' + scope.type : ''}`;
}

export function analysisRows(
  input?: Partial<AnalysisScope>,
  dataset: AnalysisRow[] = records,
): AnalysisRow[] {
  const scope = normalizeAnalysisScope(input);
  return dataset
    .filter(
      (row) =>
        row.month === scope.month &&
        (scope.dept === '全部部门' || row.dept === scope.dept) &&
        (!scope.type || row.type === scope.type),
    )
    .map((row) => ({ ...row }));
}

export function analysisAmount(
  input?: Partial<AnalysisScope>,
  dataset: AnalysisRow[] = records,
) {
  return analysisRows(input, dataset).reduce((sum, row) => sum + row.amount, 0);
}

export function previous(input: AnalysisScope): AnalysisScope | null {
  const scope = normalizeAnalysisScope(input);
  return scope.month === '10' ? { ...scope, month: '09' } : null;
}

export interface AnalysisComparison {
  before: number;
  delta: number;
  pct: number | null;
}

export function change(
  input: AnalysisScope,
  dataset: AnalysisRow[] = records,
): AnalysisComparison | null {
  const scope = normalizeAnalysisScope(input);
  const prior = previous(scope);
  if (!prior) return null;
  const before = analysisAmount(prior, dataset);
  const delta = analysisAmount(scope, dataset) - before;
  return { before, delta, pct: before ? (delta / before) * 100 : null };
}

export interface AnalysisDimension {
  name: string;
  value: number;
  previous: number | null;
  delta: number | null;
  share: number;
}

export interface AnalysisModel {
  scope: AnalysisScope;
  total: number;
  count: number;
  comparison: AnalysisComparison | null;
  budget: number | null;
  summary: string;
  findings: { title: string; text: string }[];
  categories: AnalysisDimension[];
  departments: AnalysisDimension[];
  insights: { structure: string; comparison: string; departments: string };
  recommendations: string[];
}

function dimensionRows(
  scope: AnalysisScope,
  dimension: 'type' | 'dept',
  rows: AnalysisRow[],
  priorRows: AnalysisRow[] | null,
  total: number,
): AnalysisDimension[] {
  const names = dimension === 'type' ? categories : departments;
  return names
    .filter((name) =>
      dimension === 'type'
        ? !scope.type || scope.type === name
        : scope.dept === '全部部门' || scope.dept === name,
    )
    .map((name) => {
      const value = rows
        .filter((row) => row[dimension] === name)
        .reduce((sum, row) => sum + row.amount, 0);
      const before =
        priorRows === null
          ? null
          : priorRows
              .filter((row) => row[dimension] === name)
              .reduce((sum, row) => sum + row.amount, 0);
      return {
        name,
        value,
        previous: before,
        delta: before === null ? null : value - before,
        share: total ? (value / total) * 100 : 0,
      };
    });
}

function movement(delta: number) {
  return delta === 0
    ? '持平'
    : `${delta > 0 ? '增加' : '减少'}${wan(Math.abs(delta))}万元`;
}

function comparisonText(
  comparison: AnalysisComparison | null,
  categoryRows: AnalysisDimension[],
  departmentRows: AnalysisDimension[],
): string {
  if (!comparison) return '缺少2026年8月同口径数据，暂不计算环比。';
  const { before, delta, pct } = comparison;
  if (before === 0) {
    return `9月基期金额为0，本期${delta === 0 ? '同样为0' : `增加${wan(delta)}万元`}，不计算环比比例。`;
  }
  const headline =
    delta === 0
      ? `费用与9月持平，均为${wan(before)}万元。`
      : `费用较9月${movement(delta)}（${pct! > 0 ? '+' : ''}${pct!.toFixed(1)}%）。`;
  // 只选一种费用时，从部门解释增减，避免把筛选结果误写成结构集中。
  const byDepartment = categoryRows.length === 1 && departmentRows.length > 1;
  const rows = byDepartment ? departmentRows : categoryRows;
  const changed = rows.filter((row) => row.delta !== null && row.delta !== 0);
  if (rows.length <= 1 || changed.length === 0) return headline;
  const details = changed
    .map(
      (row) => `${row.name}${byDepartment ? '部' : ''}${movement(row.delta!)}`,
    )
    .join('；');
  const increase = changed.reduce(
    (sum, row) => sum + Math.max(row.delta!, 0),
    0,
  );
  const decrease = changed.reduce(
    (sum, row) => sum + Math.max(-row.delta!, 0),
    0,
  );
  const offset =
    increase > 0 && decrease > 0
      ? delta === 0
        ? '增减相互抵消，净变化为0。'
        : `增加合计${wan(increase)}万元，减少合计${wan(decrease)}万元，抵消后净${movement(delta)}。`
      : '';
  return `${headline}${details}。${offset}`;
}

export function buildAnalysisModel(
  input?: Partial<AnalysisScope>,
  dataset: AnalysisRow[] = records,
): AnalysisModel {
  const scope = normalizeAnalysisScope(input);
  const rows = analysisRows(scope, dataset);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const prior = previous(scope);
  const priorRows = prior ? analysisRows(prior, dataset) : null;
  const comparison = change(scope, dataset);
  const categoryRows = dimensionRows(scope, 'type', rows, priorRows, total);
  const departmentRows = dimensionRows(scope, 'dept', rows, priorRows, total);
  const budget =
    scope.month === '10' && scope.dept === '全部部门' && !scope.type
      ? 600000
      : null;
  const topCategory = [...categoryRows].sort((a, b) => b.value - a.value)[0]!;
  const topDepartment = [...departmentRows].sort(
    (a, b) => b.value - a.value,
  )[0]!;
  const structure =
    total === 0
      ? '当前范围无已完成报销费用，不计算费用结构占比。'
      : scope.type
        ? `当前范围仅统计${scope.type}费用，合计${wan(total)}万元；未纳入其他费用类型。`
        : `${topCategory.name}费用${wan(topCategory.value)}万元，占本期费用${topCategory.share.toFixed(1)}%，为金额最高的费用类型。`;
  const departmentInsight =
    total === 0
      ? `${scope.dept === '全部部门' ? '各部门' : scope.dept + '部'}在当前范围均无已完成报销费用，不进行金额排名。`
      : scope.dept !== '全部部门'
        ? `当前范围为${scope.dept}部，合计${wan(total)}万元；未与其他部门比较。`
        : `${topDepartment.name}部费用${wan(topDepartment.value)}万元，占当前范围${topDepartment.share.toFixed(1)}%，为金额最高的部门。`;
  const comparisonInsight = comparisonText(
    comparison,
    categoryRows,
    departmentRows,
  );
  const opening = `${analysisScopeLabel(scope)}，已完成报销费用${wan(total)}万元，共${rows.length}条汇总记录。`;
  const movementRows =
    categoryRows.length === 1 ? departmentRows : categoryRows;
  const mainChange = [...movementRows].sort(
    (a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0),
  )[0];
  const netChange = !comparison
    ? '缺少8月同口径数据，暂不计算环比。'
    : comparison.before === 0
      ? '9月基期金额为0，不计算环比比例。'
      : `费用较9月${movement(comparison.delta)}${comparison.delta === 0 ? '' : `（${comparison.pct! > 0 ? '+' : ''}${comparison.pct!.toFixed(1)}%）`}。`;
  const changeFocus = !comparison
    ? '补充8月同口径报销记录后，可进行环比比较。'
    : total === 0
      ? '当前范围没有已完成报销费用。'
      : comparison.delta === 0
        ? '费用总额与9月持平；分项增减请查看月度比较。'
        : mainChange?.delta
          ? `${mainChange.name}${categoryRows.length === 1 ? '部' : ''}${movement(mainChange.delta)}，是当前范围变动金额最大的分项。`
          : netChange;
  const summary = `${opening}${netChange}${comparison?.delta && mainChange?.delta ? `${mainChange.name}${categoryRows.length === 1 ? '部' : ''}${movement(mainChange.delta)}；业务原因仍需核实。` : ''}`;
  const recommendations =
    total === 0
      ? [
          '核对统计月份、部门和费用类型；若预期存在费用，检查单据是否已完成审批及其审批完成日。',
          '补充费用发生日与付款记录后，再判断是否存在尚未审批或尚未支付的费用。',
        ]
      : [
          `核对${scope.type || topCategory.name}费用明细及审批完成日，结合费用发生日检查是否存在跨期报销。`,
          comparison === null
            ? '补充8月同部门、同费用类型的已完成报销记录后，再开展环比比较。'
            : '补充对应业务活动、人数和单次成本记录，再判断金额变化原因；当前金额差异不构成因果证明。',
          budget === null
            ? '如需评估预算执行，补充当前月份、部门和费用类型的同口径预算。'
            : `结合剩余预算${wan(budget - total)}万元与尚未审批的费用，核对后续预算安排。`,
        ];
  return {
    scope,
    total,
    count: rows.length,
    comparison,
    budget,
    summary,
    findings: [
      {
        title:
          comparison === null
            ? '本期费用与比较边界'
            : comparison.delta === 0
              ? '费用总额持平'
              : `费用${movement(comparison.delta)}`,
        text: changeFocus,
      },
      { title: '费用结构', text: structure },
      { title: '部门分布', text: departmentInsight },
    ],
    categories: categoryRows,
    departments: departmentRows,
    insights: {
      structure,
      comparison: comparisonInsight,
      departments: departmentInsight,
    },
    recommendations,
  };
}

export function analysisSummary(
  input?: Partial<AnalysisScope>,
  dataset: AnalysisRow[] = records,
) {
  return buildAnalysisModel(input, dataset).summary;
}

export function parseAnalysisScope(
  text: string,
  base: AnalysisScope = DEFAULT_ANALYSIS_SCOPE,
): AnalysisScope {
  const scope = { ...normalizeAnalysisScope(base) };
  const match = text.match(/(?:2026年|2026-)?(9|09|10)月/);
  if (match) scope.month = match[1] === '10' ? '10' : '09';
  for (const department of departments)
    if (text.includes(department)) scope.dept = department;
  if (/全集团|集团|全部部门/.test(text)) scope.dept = '全部部门';
  for (const category of categories)
    if (text.includes(category)) scope.type = category;
  if (/全部费用|费用总额|费用结构/.test(text)) scope.type = null;
  return scope;
}
