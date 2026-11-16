import {
  initialRules,
  type Metric,
  type Scope,
  type SystemKey,
} from '../srs-review/model.js';
import type { WorkspaceRule } from './RulesSubmission.js';

export type DemoRule = WorkspaceRule & {
  category:
    | 'general'
    | 'invoice'
    | 'itinerary'
    | 'transport'
    | 'lodging'
    | 'business_entertainment';
  logic: string;
  applicability: string[];
  evidence: { name: string; source: string; purpose: string }[];
  output: string;
  missing: string;
  source: string;
  updatedAt: string;
  revisions: { version: number; at: string; summary: string; logic: string }[];
  stage: 'published' | 'draft';
};

export interface DemoRuleDraft {
  text: string;
  generated: DemoRule | null;
  generatedFrom: string;
  savedAt: string;
  baseVersion: number | null;
}

export interface RuleCenterState {
  rules: DemoRule[];
  drafts: Record<string, DemoRuleDraft>;
  editingId: string | null;
}

export const RULE_CENTER_KEY = 'srsRuleCenterV1';
export const CATEGORY_LABELS: Record<DemoRule['category'], string> = {
  general: '通用检查',
  invoice: '发票',
  itinerary: '行程',
  transport: '交通',
  lodging: '住宿',
  business_entertainment: '业务招待',
};

export const RULE_EXAMPLES: { id: string; title: string; text: string }[] = [
  {
    id: 'lodging',
    title: '住宿费用提醒',
    text: '住宿费用每间夜超过600元时，审单时提醒本人。',
  },
  {
    id: 'meal',
    title: '每单餐饮提醒',
    text: '每张报销单的餐饮费用合计超过1500元时，审单时提醒本人。',
  },
  {
    id: 'invoice',
    title: '发票重复校验',
    text: '同一张发票重复用于费用报销时，审单时提醒本人。',
  },
];

const now = () =>
  new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
const categoryByMetric: Record<Metric, DemoRule['category']> = {
  amount: 'general',
  meal: 'business_entertainment',
  hotelNight: 'lodging',
  days: 'itinerary',
  invoiceUnique: 'invoice',
  validInvoice: 'invoice',
  attachment: 'general',
};
const ruleNames: Record<Metric, string> = {
  amount: '单据金额检查',
  meal: '每单餐饮费用检查',
  hotelNight: '住宿费用标准',
  days: '申请天数检查',
  invoiceUnique: '发票重复报销校验',
  validInvoice: '发票有效性检查',
  attachment: '附件完整性检查',
};
const scopeText: Record<Scope, string> = {
  both: '提单和审单',
  review: '审单',
  submit: '提单',
};
const systemText: Record<SystemKey, string> = {
  expense: '费用报销',
  oa: 'OA办公',
};
const genericMissing =
  '必要字段或核对依据缺失时标记为“待核实”，列明缺失内容；补充后重新检查，不直接判为通过。';

function actionText(rule: WorkspaceRule): string {
  return rule.effect === 'block'
    ? '阻断提单'
    : `${scopeText[rule.scope]}时提醒本人`;
}

function businessLogic(rule: WorkspaceRule): string {
  const amount = (rule.thresholdMinor ?? 0) / 100;
  const condition: Record<Metric, string> = {
    amount: `每张报销单的报销金额超过${amount}元`,
    meal: `每张报销单的餐饮费用合计超过${amount}元`,
    hotelNight: `住宿费用每间夜超过${amount}元`,
    days: `OA申请天数超过${rule.thresholdDays ?? 0}天`,
    invoiceUnique: '同一张发票重复用于费用报销',
    validInvoice: '报销发票查验为无效',
    attachment:
      rule.system === 'oa'
        ? 'OA申请缺少对应证明材料'
        : '报销单缺少对应费用凭证',
  };
  return `${condition[rule.metric]}时，${actionText(rule)}。`;
}

function metadata(
  rule: WorkspaceRule,
): Pick<
  DemoRule,
  'category' | 'applicability' | 'evidence' | 'output' | 'missing'
> {
  const applicability = [
    `${systemText[rule.system]}系统`,
    `${scopeText[rule.scope]}场景`,
  ];
  let evidence: DemoRule['evidence'];
  let output: string;
  switch (rule.metric) {
    case 'hotelNight':
      applicability.push('报销单包含住宿费用项');
      evidence = [
        {
          name: '住宿金额与间夜数',
          source: '报销单 · 住宿明细',
          purpose: '计算每项住宿的每间夜单价',
        },
        {
          name: '住宿费用凭证',
          source: '报销单 · 关联附件',
          purpose: '核对住宿金额与入住、离店信息',
        },
      ];
      output =
        '按每项住宿费用输出检查结果，列明每间夜单价、标准和超额金额；不同住宿项分别核对。';
      break;
    case 'meal':
      applicability.push('报销单包含餐饮费用项');
      evidence = [
        {
          name: '餐饮费用明细',
          source: '报销单 · 费用明细',
          purpose: '归集同一张报销单中的全部餐饮费用',
        },
        {
          name: '餐饮费用凭证',
          source: '报销单 · 关联附件',
          purpose: '核对餐饮类别与金额',
        },
      ];
      output =
        '每张报销单输出一条餐饮合计检查结果，列明餐饮合计金额与阈值，不按单张发票分别触发。';
      break;
    case 'amount':
      evidence = [
        {
          name: '单据报销金额',
          source: '报销单 · 单据金额',
          purpose: '读取整张报销单的报销金额',
        },
      ];
      output = '每张报销单输出一条金额检查结果，列明单据金额与阈值。';
      break;
    case 'days':
      evidence = [
        {
          name: '申请天数',
          source: 'OA申请 · 申请信息',
          purpose: '读取本次申请的天数',
        },
      ];
      output = '每张OA申请输出一条天数检查结果，列明申请天数与阈值。';
      break;
    case 'invoiceUnique':
      applicability.push('报销单关联发票');
      evidence = [
        {
          name: '发票标识',
          source: '报销单 · 发票信息',
          purpose: '识别同一张发票',
        },
        {
          name: '发票使用记录',
          source: '费用报销 · 发票关联记录',
          purpose: '核对当前发票是否已用于其他报销单',
        },
      ];
      output =
        '按每张发票输出重复校验结果；发现重复时列明发票标识与关联报销单。';
      break;
    case 'validInvoice':
      applicability.push('报销单关联发票');
      evidence = [
        {
          name: '发票查验结果',
          source: '发票查验 · 返回记录',
          purpose: '核对发票是否已取得有效的查验结论',
        },
      ];
      output = '按每张发票输出有效性检查结果；未取得查验结果的发票保持待核实。';
      break;
    case 'attachment':
      evidence = [
        {
          name: rule.system === 'oa' ? '申请证明材料' : '费用凭证',
          source: `${systemText[rule.system]} · 单据关联附件`,
          purpose: '核对当前单据是否包含对应材料',
        },
      ];
      output =
        '每张单据输出一条材料完整性检查结果，缺失时列明待补充的材料类型。';
      break;
  }
  return {
    category: categoryByMetric[rule.metric],
    applicability,
    evidence,
    output,
    missing:
      rule.metric === 'attachment'
        ? `确认未附必需材料时，${rule.effect === 'block' ? '判为不符合要求并阻断提单' : '触发提醒'}，列明待补材料；附件信息尚未取得或无法核对时标记为“待核实”，补充后重新检查。`
        : genericMissing,
  };
}

export function readRuleCenter(data: Record<string, any>): RuleCenterState {
  if (data[RULE_CENTER_KEY]) {
    const cached = data[RULE_CENTER_KEY] as RuleCenterState;
    let changed = false;
    const refreshMissing = (rule: DemoRule): DemoRule => {
      if (rule.metric !== 'attachment' || rule.missing !== genericMissing)
        return rule;
      changed = true;
      return { ...rule, missing: metadata(rule).missing };
    };
    const rules = cached.rules.map(refreshMissing);
    const drafts = Object.fromEntries(
      Object.entries(cached.drafts).map(([id, draft]) => {
        const generated = draft.generated
          ? refreshMissing(draft.generated)
          : null;
        return [
          id,
          generated === draft.generated ? draft : { ...draft, generated },
        ];
      }),
    );
    return changed ? { ...cached, rules, drafts } : cached;
  }
  const localRules = data.rulesSubmission?.rules;
  const rules: WorkspaceRule[] = Array.isArray(localRules)
    ? localRules
    : initialRules.map(({ threshold, ...rule }) => ({
        ...rule,
        ...(threshold === undefined
          ? {}
          : rule.metric === 'days'
            ? { thresholdDays: threshold }
            : { thresholdMinor: Math.round(threshold * 100) }),
      }));
  const at = now();
  return {
    rules: rules.map((rule) => {
      const logic = businessLogic(rule);
      return {
        ...rule,
        ...metadata(rule),
        logic,
        source: rule.origin === 'builtin' ? '公司通用规则' : '本人维护',
        updatedAt: at,
        revisions: [
          { version: rule.version, at, summary: '载入现有规则', logic },
        ],
        stage: 'published',
      };
    }),
    drafts: {},
    editingId: null,
  };
}

type ParsedCondition = Pick<
  WorkspaceRule,
  'metric' | 'system' | 'thresholdMinor' | 'thresholdDays'
>;
const numberPattern = '(\\d+(?:\\.\\d{1,2})?)';
const numericPatterns: {
  pattern: RegExp;
  metric: Metric;
  system: SystemKey;
}[] = [
  {
    pattern: new RegExp(
      `^(?:每张报销单的|每单)?餐饮(?:费用)?合计超过${numberPattern}元$`,
    ),
    metric: 'meal',
    system: 'expense',
  },
  {
    pattern: new RegExp(
      `^(?:每张报销单的)?(?:报销|单据)金额超过${numberPattern}元$`,
    ),
    metric: 'amount',
    system: 'expense',
  },
  {
    pattern: new RegExp(`^住宿(?:费用)?每间夜超过${numberPattern}元$`),
    metric: 'hotelNight',
    system: 'expense',
  },
  {
    pattern: new RegExp(`^住宿(?:费用|单价)?超过${numberPattern}元/间夜$`),
    metric: 'hotelNight',
    system: 'expense',
  },
  {
    pattern: new RegExp(`^(?:OA)?申请天数超过${numberPattern}天$`, 'i'),
    metric: 'days',
    system: 'oa',
  },
];

function parseCondition(text: string): ParsedCondition | null {
  for (const { pattern, metric, system } of numericPatterns) {
    const matched = text.match(pattern);
    if (!matched) continue;
    const [whole, fraction = ''] = matched[1]!.split('.');
    const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 10000000000)
      return null;
    return {
      metric,
      system,
      ...(metric === 'days'
        ? { thresholdDays: minor / 100 }
        : { thresholdMinor: minor }),
    };
  }
  const fixed: Record<string, ParsedCondition> = {
    同一张发票重复用于费用报销: { metric: 'invoiceUnique', system: 'expense' },
    发票重复用于费用报销: { metric: 'invoiceUnique', system: 'expense' },
    发票重复报销: { metric: 'invoiceUnique', system: 'expense' },
    报销发票查验为无效: { metric: 'validInvoice', system: 'expense' },
    报销单缺少对应费用凭证: { metric: 'attachment', system: 'expense' },
    OA申请缺少对应证明材料: { metric: 'attachment', system: 'oa' },
  };
  return fixed[text] ?? null;
}

let generatedSequence = 0;
function newRuleId(): string {
  generatedSequence += 1;
  return `P-${Date.now().toString(36)}-${generatedSequence.toString(36)}`;
}

export function generateDemoRule(
  text: string,
  base?: DemoRule,
): { rule?: DemoRule; error?: string } {
  const clean = text
    .trim()
    .replace(/\s+/g, '')
    .replace(/[。.]$/, '');
  if (!clean) return { error: '请填写业务逻辑。' };
  // Match the whole sentence. Extra exceptions, locations or clauses must never be silently dropped.
  const matched = clean.match(
    /^(.*?)(?:时)?[，,]?(阻断提单|(?:(提单和审单|提单、审单|审单|提单)时)?提醒(?:本人|我))$/,
  );
  const unsupported =
    '当前仅支持示例中的单项检查及数字调整。请使用完整的示例句式；地区、人员例外或多个条件暂无法生成。';
  if (!matched) return { error: unsupported };
  const condition = parseCondition(matched[1]!);
  if (!condition) return { error: unsupported };
  const effect = matched[2] === '阻断提单' ? 'block' : 'warn';
  const origin = base?.origin ?? 'personal';
  if (origin === 'personal' && effect === 'block') {
    return {
      error: '个人规则仅可提醒本人，不能阻断提单。请将处理方式改为“提醒本人”。',
    };
  }
  const scope: Scope =
    effect === 'block'
      ? 'both'
      : matched[3] === '审单'
        ? 'review'
        : matched[3] === '提单'
          ? 'submit'
          : matched[3]
            ? 'both'
            : (base?.scope ?? 'review');
  const workspaceRule: WorkspaceRule = {
    id: base?.id ?? newRuleId(),
    name:
      base?.metric === condition.metric
        ? base.name
        : ruleNames[condition.metric],
    ...condition,
    origin,
    scope,
    effect,
    enabled: base?.enabled ?? true,
    version: base?.version ?? 0,
    description: text.trim(),
  };
  const rule: DemoRule = {
    ...workspaceRule,
    ...metadata(workspaceRule),
    logic: text.trim(),
    source: base?.source ?? '本人维护',
    updatedAt: base?.updatedAt ?? '',
    revisions: base?.revisions.map((revision) => ({ ...revision })) ?? [],
    stage: 'draft',
  };
  return { rule };
}

export function publishDemoRule(rule: DemoRule, previous?: DemoRule): DemoRule {
  const version = previous ? previous.version + 1 : 1;
  const at = now();
  return {
    ...rule,
    version,
    enabled: previous?.enabled ?? true,
    updatedAt: at,
    stage: 'published',
    applicability: [...rule.applicability],
    evidence: rule.evidence.map((item) => ({ ...item })),
    revisions: [
      ...(previous?.revisions ?? []).map((revision) => ({ ...revision })),
      {
        version,
        at,
        summary: previous ? '更新业务逻辑' : '创建规则',
        logic: rule.logic,
      },
    ],
  };
}

export function toWorkspaceRule(rule: DemoRule): WorkspaceRule {
  return {
    id: rule.id,
    name: rule.name,
    system: rule.system,
    origin: rule.origin,
    scope: rule.scope,
    metric: rule.metric,
    effect: rule.effect,
    enabled: rule.enabled,
    version: rule.version,
    description: rule.description,
    ...(rule.thresholdMinor === undefined
      ? {}
      : { thresholdMinor: rule.thresholdMinor }),
    ...(rule.thresholdDays === undefined
      ? {}
      : { thresholdDays: rule.thresholdDays }),
  };
}

export function isDraftCurrent(draft: DemoRuleDraft): boolean {
  return draft.generated !== null && draft.generatedFrom === draft.text.trim();
}
