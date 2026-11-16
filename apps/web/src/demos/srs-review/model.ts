export type SystemKey = 'expense' | 'oa';
export type Metric =
  | 'amount'
  | 'meal'
  | 'hotelNight'
  | 'days'
  | 'invoiceUnique'
  | 'validInvoice'
  | 'attachment';
export type Scope = 'both' | 'submit' | 'review';
export interface Rule {
  id: string;
  name: string;
  system: SystemKey;
  origin: 'builtin' | 'personal';
  scope: Scope;
  metric: Metric;
  threshold?: number;
  effect: 'block' | 'warn';
  enabled: boolean;
  version: number;
  description: string;
}
export interface BusinessDoc {
  id: string;
  title: string;
  system: SystemKey;
  kind: string;
  person: string;
  department: string;
  amount?: number;
  meal?: number;
  hotelNight?: number;
  nights?: number;
  days?: number;
  period: string;
  invoiceUnique?: boolean;
  validInvoice?: boolean | null;
  attachment: boolean;
  stage: '待审批' | '草稿' | '审批中';
  version: number;
}
export interface Finding {
  rule: Rule;
  state: 'hit' | 'unknown';
  actual: string;
  expected: string;
  detail: string;
}
export interface Review {
  status: 'attention' | 'unknown' | 'clear';
  findings: Finding[];
  passed: Rule[];
  applicable: Rule[];
}
export const systemNames: Record<SystemKey, string> = {
  expense: '费用报销',
  oa: 'OA办公',
};
export const scopeNames: Record<Scope, string> = {
  both: '提单、审单',
  submit: '提单',
  review: '审单',
};
export const metricNames: Record<Metric, string> = {
  amount: '单据金额',
  meal: '餐饮合计',
  hotelNight: '住宿单价',
  days: '申请天数',
  invoiceUnique: '发票重复',
  validInvoice: '发票有效性',
  attachment: '附件完整性',
};
export const statusNames = {
  attention: '需关注',
  unknown: '待核实',
  clear: '未发现异常',
};
export const money = (n: number) =>
  '¥' +
  n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const initialRules: Rule[] = [
  {
    id: 'R001',
    name: '发票重复报销校验',
    system: 'expense',
    origin: 'builtin',
    scope: 'both',
    metric: 'invoiceUnique',
    effect: 'block',
    enabled: true,
    version: 2,
    description: '同一张发票不得重复用于费用报销。',
  },
  {
    id: 'R002',
    name: '住宿费用标准',
    system: 'expense',
    origin: 'builtin',
    scope: 'both',
    metric: 'hotelNight',
    threshold: 600,
    effect: 'block',
    enabled: true,
    version: 3,
    description: '普通员工差旅住宿费用不超过600元/间夜。',
  },
  {
    id: 'R003',
    name: '发票有效性检查',
    system: 'expense',
    origin: 'builtin',
    scope: 'both',
    metric: 'validInvoice',
    effect: 'block',
    enabled: true,
    version: 2,
    description: '报销发票须取得有效的查验结果。',
  },
  {
    id: 'R004',
    name: '费用附件完整性',
    system: 'expense',
    origin: 'builtin',
    scope: 'both',
    metric: 'attachment',
    effect: 'block',
    enabled: true,
    version: 1,
    description: '报销单须包含对应的费用凭证。',
  },
  {
    id: 'R005',
    name: '申请材料完整性',
    system: 'oa',
    origin: 'builtin',
    scope: 'both',
    metric: 'attachment',
    effect: 'block',
    enabled: true,
    version: 1,
    description: 'OA申请须附对应的证明材料。',
  },
  {
    id: 'P001',
    name: '大额餐饮提醒',
    system: 'expense',
    origin: 'personal',
    scope: 'review',
    metric: 'meal',
    threshold: 1500,
    effect: 'warn',
    enabled: true,
    version: 1,
    description: '餐饮费用合计超过1500元时，审单时提醒我。',
  },
  {
    id: 'P002',
    name: '长时间出差提醒',
    system: 'oa',
    origin: 'personal',
    scope: 'review',
    metric: 'days',
    threshold: 5,
    effect: 'warn',
    enabled: false,
    version: 1,
    description: '申请天数超过5天时，审单时提醒我。',
  },
];
export const initialDocs: BusinessDoc[] = [
  {
    id: 'BX-20261116-001',
    title: '上海客户拜访差旅报销',
    system: 'expense',
    kind: '差旅报销',
    person: '林晓',
    department: '市场部',
    amount: 3260,
    hotelNight: 780,
    nights: 2,
    meal: 280,
    period: '11月12日 — 11月14日',
    invoiceUnique: true,
    validInvoice: true,
    attachment: true,
    stage: '待审批',
    version: 2,
  },
  {
    id: 'BX-20261116-002',
    title: '客户交流活动费用',
    system: 'expense',
    kind: '费用报销',
    person: '陈澄',
    department: '销售部',
    amount: 1860,
    meal: 680,
    period: '11月13日',
    invoiceUnique: false,
    validInvoice: true,
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'BX-20261116-003',
    title: '北京项目交付差旅',
    system: 'expense',
    kind: '差旅报销',
    person: '周宁',
    department: '研发部',
    amount: 2400,
    hotelNight: 560,
    nights: 2,
    period: '11月10日 — 11月12日',
    invoiceUnique: true,
    validInvoice: null,
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'BX-20261116-004',
    title: '渠道客户商务午餐',
    system: 'expense',
    kind: '费用报销',
    person: '刘昕',
    department: '销售部',
    amount: 1680,
    meal: 1680,
    period: '11月14日',
    invoiceUnique: true,
    validInvoice: true,
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'BX-20261116-005',
    title: '杭州项目交通费用',
    system: 'expense',
    kind: '费用报销',
    person: '沈一',
    department: '研发部',
    amount: 680,
    period: '11月13日',
    invoiceUnique: true,
    validInvoice: true,
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'BX-20261116-006',
    title: '财务培训交通费用',
    system: 'expense',
    kind: '费用报销',
    person: '孙悦',
    department: '财务部',
    amount: 920,
    period: '11月14日',
    invoiceUnique: true,
    validInvoice: true,
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'OA-20261116-017',
    title: '年休假申请',
    system: 'oa',
    kind: '请假申请',
    person: '赵佳',
    department: '人力资源部',
    days: 3,
    period: '11月18日 — 11月20日',
    attachment: true,
    stage: '待审批',
    version: 1,
  },
  {
    id: 'OA-20261116-021',
    title: '南京项目出差申请',
    system: 'oa',
    kind: '出差申请',
    person: '许言',
    department: '运营部',
    days: 6,
    period: '11月23日 — 11月28日',
    attachment: true,
    stage: '待审批',
    version: 1,
  },
];
export const initialDraft: BusinessDoc = {
  ...initialDocs[0]!,
  id: 'BX-DRAFT-001',
  person: '王懿',
  department: '财务部',
  stage: '草稿',
  version: 1,
};
export function ruleCondition(rule: Rule): string {
  if (rule.threshold !== undefined)
    return `${metricNames[rule.metric]} > ${rule.metric === 'days' ? rule.threshold + '天' : money(rule.threshold) + (rule.metric === 'hotelNight' ? '/间夜' : '')}`;
  return rule.description;
}
export function evaluate(
  doc: BusinessDoc,
  rules: Rule[],
  scope: 'submit' | 'review' = 'review',
): Review {
  const applicable = rules.filter(
    (r) =>
      r.enabled &&
      r.system === doc.system &&
      (r.scope === 'both' || r.scope === scope) &&
      (r.threshold === undefined ||
        typeof doc[r.metric as 'amount'] === 'number'),
  );
  const findings: Finding[] = [];
  const passed: Rule[] = [];
  for (const rule of applicable) {
    let finding: Omit<Finding, 'rule'> | undefined;
    const value = doc[rule.metric as keyof BusinessDoc];
    if (rule.metric === 'validInvoice' && value === null)
      finding = {
        state: 'unknown',
        actual: '尚未取得查验结果',
        expected: '发票查验有效',
        detail:
          '查验服务暂未返回结果，请稍后重新审查。当前无法确认发票有效性。',
      };
    else if (
      rule.threshold !== undefined &&
      typeof value === 'number' &&
      value > rule.threshold
    ) {
      const format = (n: number) =>
        rule.metric === 'days'
          ? n + '天'
          : money(n) + (rule.metric === 'hotelNight' ? '/间夜' : '');
      finding = {
        state: 'hit',
        actual: format(value),
        expected:
          rule.origin === 'personal'
            ? '超过 ' + format(rule.threshold) + ' 时提醒'
            : '不超过 ' + format(rule.threshold),
        detail:
          rule.origin === 'builtin' && rule.metric === 'hotelNight'
            ? `${doc.nights || 1}间夜住宿合计${money(value * (doc.nights || 1))}，超出标准${money((value - rule.threshold) * (doc.nights || 1))}。`
            : `${metricNames[rule.metric]}超过设定值。这是你的个人提醒，不影响其他人的审批设置。`,
      };
    } else if (value === false)
      finding = {
        state: 'hit',
        actual:
          rule.metric === 'invoiceUnique'
            ? '发票尾号6739已关联其他单据'
            : rule.metric === 'attachment'
              ? '缺少证明材料'
              : '发票查验未通过',
        expected: rule.description,
        detail:
          rule.metric === 'invoiceUnique'
            ? '该发票已关联BX-20261109-018，金额¥680.00。请核对原报销记录。'
            : '请补充或更正材料后重新审查。',
      };
    if (finding) findings.push({ rule, ...finding });
    else passed.push(rule);
  }
  return {
    status: findings.some((f) => f.state === 'hit')
      ? 'attention'
      : findings.length
        ? 'unknown'
        : 'clear',
    findings,
    passed,
    applicable,
  };
}
export function summary(docs: BusinessDoc[], rules: Rule[]) {
  return docs.reduce(
    (out, d) => {
      out[evaluate(d, rules).status]++;
      return out;
    },
    { attention: 0, unknown: 0, clear: 0 },
  );
}
export function rulesSignature(
  rules: Rule[],
  scope: 'submit' | 'review',
  system?: SystemKey,
) {
  return JSON.stringify(
    rules
      .filter(
        (rule) =>
          rule.enabled &&
          (rule.scope === 'both' || rule.scope === scope) &&
          (!system || rule.system === system),
      )
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
