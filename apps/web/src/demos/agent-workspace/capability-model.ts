import type { PageId } from './workspace';
import { selectPromptExamples } from './prompt-model';

export type CapabilityId =
  | 'submission'
  | 'rules'
  | 'analysis'
  | 'documents'
  | 'knowledge'
  | 'materials'
  | 'receipt'
  | 'translation'
  | 'contract';

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
    placeholder: '告诉我分析期间、部门和想了解的费用问题…',
    featured: true,
    description: '指定期间、部门与费用范围',
    examples: [
      '分析10月各部门的费用构成',
      '对比销售部9月与10月的差旅费用',
      '10月报销费用比9月变化了多少？',
      '查看10月差旅费用的部门分布',
      '生成10月销售部费用分析报告',
      '汇总10月各类报销费用及占比',
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
    placeholder: '上传需要翻译的文件，告诉我目标语言及格式要求…',
    featured: false,
    description: '上传文件并指定目标语言',
    examples: [
      '将这份英文发票翻译为中文',
      '把合同附件翻译成英文，保留财务术语',
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
): Capability | undefined {
  return capabilities.find((capability) => capability.id === id);
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
