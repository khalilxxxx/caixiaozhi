export const homeExamples = [
  '帮我整理上海客户拜访的票据，核对报销信息',
  '查一下上海出差申请的审批进展',
  '检查今天的待审单据，列出需要关注的事项',
  '分析10月各部门的费用构成',
  '10月报销费用比9月变化了多少？',
  '查询上海出差的住宿标准',
  '帮我准备一份差旅申请',
  '添加一条超标准住宿费用检查规则',
  '生成10月销售部费用分析报告',
  '查看采购付款单的办理进度',
];

export function selectPromptExamples(
  previous: readonly string[] = [],
  random: () => number = Math.random,
): string[] {
  const candidates = homeExamples.filter((text) => !previous.includes(text));
  const pool = candidates.length >= 3 ? candidates : [...homeExamples];
  const selected: string[] = [];
  while (selected.length < 3 && pool.length) {
    const index = Math.floor(random() * pool.length);
    selected.push(...pool.splice(index, 1));
  }
  return selected;
}

export const shortcutPrompts = [
  {
    id: 'receipt',
    title: '回单查询',
    icon: 'wallet',
    description: '按账户、日期或付款信息查询',
    keywords: '银行 付款 支付 凭证 receipt',
    text: '我需要查询银行回单，请先确认付款账户、交易日期和收款方信息，再查询对应回单。',
  },
  {
    id: 'translation',
    title: '附件翻译',
    icon: 'file',
    description: '选择附件并明确目标语言',
    keywords: '语言 英文 中文 translate',
    text: '我需要翻译附件，请先确认待翻译文件和目标语言，并保留原文中的金额、日期和专业术语。',
  },
  {
    id: 'contract',
    title: '合同分析',
    icon: 'shield',
    description: '核对付款条款与履约风险',
    keywords: '条款 付款 风险 contract',
    text: '我需要分析合同，请先确认合同文件，重点核对付款条款、履约责任和违约风险，并列出需要人工确认的事项。',
  },
];
