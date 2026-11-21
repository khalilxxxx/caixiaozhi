import type { ContextRef, PageId } from './workspace';
import { selectPromptExamples } from './prompt-model';
import { appendDraft } from './task-model';

export type ExpertTeamId =
  | 'finance-review-team'
  | 'finance-analysis-team'
  | `expert-team-${string}`;

export function isExpertTeam(id?: string | null): id is ExpertTeamId {
  return id === 'finance-review-team' ||
    id === 'finance-analysis-team' ||
    (typeof id === 'string' && id.startsWith('expert-team-'));
}

export type CapabilityId =
  | 'submission'
  | 'rules'
  | 'analysis'
  | 'documents'
  | 'knowledge'
  | 'materials'
  | 'receipt'
  | 'translation'
  | 'contract'
  | ExpertTeamId;

export interface Capability {
  id: CapabilityId;
  label: string;
  icon: string;
  appId: PageId;
  placeholder: string;
  featured: boolean;
  description: string;
  examples: readonly string[];
}

export const capabilities: readonly Capability[] = [
  {
    id: 'finance-review-team',
    label: '财务核验专家团',
    icon: 'shield',
    appId: 'skills',
    placeholder: '输入要核对的单据、材料或制度问题…',
    featured: false,
    description: '核对业务单据、报销材料与适用制度',
    examples: [
      '这张报销单还缺哪些材料？',
      '帮我核对这次出差的住宿标准',
      '核对附件和报销单中的金额',
      '请列出需要补充的报销材料',
      '查询这张单据适用的差旅制度',
      '核对这张报销单的费用日期和提交时间',
    ],
  },
  {
    id: 'finance-analysis-team',
    label: '财务分析专家团',
    icon: 'chart',
    appId: 'skills',
    placeholder: '输入费用期间或财报问题，也可以附上费用 CSV…',
    featured: false,
    description: '汇总费用，分析费用结构与公开财报',
    examples: [
      '分析海康威视2025年度的收入与利润',
      '汇总我上传的费用 CSV，列出各类费用小计',
      '比较2026年9月和10月的部门费用',
      '列出2026年10月各类费用占比',
      '对照年报核实海康威视2025年度的归母净利润',
      '核对这份费用 CSV 的行数和总金额',
    ],
  },
  {
    id: 'submission',
    label: '智能提单',
    icon: 'file',
    appId: 'submission',
    placeholder: '告诉我需要申请或报销的事项，也可以上传相关材料…',
    featured: true,
    description: '说明办理事项、人员与费用信息',
    examples: [
      '帮我准备一份下周去上海的差旅申请',
      '根据这些材料起草差旅报销单',
      '帮我填写这次客户拜访的费用报销',
      '修改差旅申请中的出发日期',
      '检查这张报销草稿还缺哪些信息',
      '补充这次出差的同行人员和行程',
    ],
  },
  {
    id: 'rules',
    label: '规则配置',
    icon: 'shield',
    appId: 'rules',
    placeholder: '描述需要检查的事项、适用范围和触发条件…',
    featured: true,
    description: '说明检查对象、条件与适用范围',
    examples: [
      '添加一条超标准住宿费用检查规则',
      '查看差旅报销适用的检查规则',
      '新增报销材料完整性检查规则',
      '调整招待费用规则的适用部门',
      '设置重复票据的检查条件',
      '查看我创建的个人规则',
    ],
  },
  {
    id: 'analysis',
    label: '数据分析',
    icon: 'chart',
    appId: 'analysis',
    placeholder: '输入年度和财务问题，例如分析海康威视2025年度研发费用…',
    featured: true,
    description: '查询公开财报指标、年度变化与报告',
    examples: [
      '分析海康威视2025年度的营收与利润',
      '对比海康威视2024与2025年度的研发费用',
      '海康威视2025年度营业收入同比变化了多少？',
      '查看海康威视2025年度的成本费用结构',
      '生成海康威视2025年度财务分析报告',
      '核查海康威视2023至2025年度财报的数据来源',
    ],
  },
  {
    id: 'documents',
    label: '单据查询',
    icon: 'clock',
    appId: 'documents',
    placeholder: '输入单据编号、事项名称，或描述要查询的单据…',
    featured: true,
    description: '提供单号、事项或办理人',
    examples: [
      '查一下上海出差申请的审批进展',
      '查看采购付款单的办理进度',
      '这张报销单现在由谁审批？',
      '查询需要我补充材料的单据',
      '查看客户拜访报销的当前状态',
      '查询这笔付款是否已有支付回执',
    ],
  },
  {
    id: 'knowledge',
    label: '制度问答',
    icon: 'book',
    appId: 'knowledge',
    placeholder: '告诉我遇到的业务问题，查询适用制度和条款…',
    featured: true,
    description: '描述业务场景与需要核对的问题',
    examples: [
      '查询上海出差的住宿标准',
      '差旅报销需要提供哪些材料？',
      '住宿超出标准需要补充什么说明？',
      '业务招待是否需要前置申请？',
      '报销审批完成是否代表已经付款？',
      '查询重复票据的报销规定',
    ],
  },
  {
    id: 'materials',
    label: '材料整理',
    icon: 'folder',
    appId: 'files',
    placeholder: '上传票据或材料，告诉我需要整理和核对的内容…',
    featured: false,
    description: '上传票据并说明费用归属',
    examples: [
      '整理上海客户拜访的报销票据',
      '核对这些票据的金额和费用类型',
      '查看这组材料中哪些字段待补充',
      '检查附件里是否存在重复票据',
      '按费用发生日期整理这批材料',
      '核对票据中的人员与业务事由',
    ],
  },
  {
    id: 'receipt',
    label: '回单查询',
    icon: 'wallet',
    appId: 'skills',
    placeholder: '告诉我付款账户、交易日期或收款方，查询对应银行回单…',
    featured: false,
    description: '提供付款账户、日期或收款方',
    examples: [
      '查询今天付给上海明远科技的银行回单',
      '按付款账户查询上周的回单',
      '查找11月12日金额为8,600元的回单',
      '查询这张付款单对应的银行回单',
      '核对回单中的收款方和付款金额',
      '查询本月已付款单据的银行回单',
    ],
  },
  {
    id: 'translation',
    label: '附件翻译',
    icon: 'file',
    appId: 'skills',
    placeholder: '上传票据图片或 PDF，翻译成中文并核对原文…',
    featured: false,
    description: '上传票据并对照中文译文',
    examples: [
      '将这份英文发票翻译为中文',
      '把这张酒店账单翻译成中文，保留币种与金额',
      '将费用说明按中英文对照输出',
      '把附件中的付款条件翻译成中文',
      '翻译这份报销凭证，保留币种与金额',
      '保留原表格结构翻译附件文字',
    ],
  },
  {
    id: 'contract',
    label: '合同分析',
    icon: 'shield',
    appId: 'skills',
    placeholder: '上传合同，告诉我需要关注的付款条款、履约责任或风险…',
    featured: false,
    description: '上传合同并指定审阅重点',
    examples: [
      '梳理合同的付款节点和验收条件',
      '检查合同里的开票要求与税费约定',
      '列出需要人工确认的违约责任条款',
      '核对合同正文与附件的付款条件',
      '总结合同的履约期限和双方责任',
      '检查提前付款的前提条件和退款约定',
    ],
  },
];

export function getCapability(
  id?: CapabilityId | null,
  teamName?: string | null,
): Capability | undefined {
  const builtin = capabilities.find((capability) => capability.id === id);
  if (builtin || !isExpertTeam(id)) return builtin;
  return {
    id, label: teamName?.trim() || '我的专家团', icon: 'spark', appId: 'skills',
    featured: false, placeholder: '输入要交给专家团处理的问题…', description: '', examples: [],
  };
}

export function expertTeamRefs(draftRefs: ContextRef[], explicitRefs: ContextRef[] = []): ContextRef[] {
  const refs = new Map<string, ContextRef>();
  for (const ref of [...draftRefs, ...explicitRefs]) {
    if (ref.kind !== 'skill') refs.set(`${ref.kind}/${ref.id}`, ref);
  }
  return [...refs.values()];
}

export function prepareExpertTeamDraft(
  draft: { input: string; refs: ContextRef[] },
  id: ExpertTeamId,
  prompt?: string,
  teamName?: string,
) {
  return {
    input: prompt?.trim() ? appendDraft(draft.input, prompt.trim()) : draft.input,
    refs: expertTeamRefs(draft.refs),
    capability: id,
    expertTeamName: getCapability(id, teamName)!.label,
  };
}

export function capabilityExamples(
  id?: CapabilityId | null,
  previous: readonly string[] = [],
  random: () => number = Math.random,
): string[] {
  const capability = getCapability(id);
  if (!capability) return selectPromptExamples(previous, random);
  const candidates = capability.examples.filter(
    (text) => !previous.includes(text),
  );
  const pool = candidates.length >= 3 ? candidates : [...capability.examples];
  const selected: string[] = [];
  while (selected.length < 3 && pool.length) {
    const index = Math.floor(random() * pool.length);
    selected.push(...pool.splice(index, 1));
  }
  return selected;
}
