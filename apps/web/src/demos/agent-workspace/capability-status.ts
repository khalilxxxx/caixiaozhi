type CapabilityNotice = { text: string; status: string; type: string };

export function unavailableCapability(
  text: string,
  previousType?: string,
): CapabilityNotice | null {
  const nextSupportedRequest =
    /(?:分析|统计|生成).*(?:\d+月|部门|集团|报销).*费用|待审单据|差旅申请|报销申请|单据(?:进展|进度)|采购付款单|新增.*规则|查询.*制度/.test(
      text,
    ) ||
    (/改为|换成|改成|另外|改做|算了/.test(text) &&
      /费用|报销|发票|单据|规则|制度|差旅|待审/.test(text));
  const previous = nextSupportedRequest ? undefined : previousType;
  const type = /回单/.test(text)
    ? 'receipt'
    : /翻译/.test(text)
      ? 'translation'
      : /合同/.test(text)
        ? 'contract'
        : previous;
  if (type === 'receipt')
    return {
      text: '当前尚未连接银行回单服务，暂时无法查询或下载回单。你的查询需求已保留在本会话中。',
      status: '未接入',
      type: 'receipt',
    };
  if (type === 'translation')
    return {
      text: '当前尚未接入附件翻译服务，暂时无法读取并翻译文件。你的翻译需求和已选附件会保留在本会话中。',
      status: '未接入',
      type: 'translation',
    };
  if (type === 'contract')
    return {
      text: '当前尚未接入合同分析服务，暂时无法生成条款分析结果。你的分析需求和已选附件会保留在本会话中。',
      status: '未接入',
      type: 'contract',
    };
  return null;
}
