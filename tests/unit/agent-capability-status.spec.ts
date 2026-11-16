import { describe, expect, it } from 'vitest';
import { unavailableCapability } from '../../apps/web/src/demos/agent-workspace/capability-status';

describe('尚未接入的对话快捷功能', () => {
  it('合同分析不会被费用分析分支冒充处理成功', () => {
    expect(unavailableCapability('帮我分析这份合同的付款条款')?.type).toBe(
      'contract',
    );
  });
  it('回单查询不会被单据查询分支冒充处理成功', () => {
    expect(unavailableCapability('查询这笔付款的银行回单')?.type).toBe(
      'receipt',
    );
  });
  it('附件翻译不会被材料归集分支冒充处理成功', () => {
    expect(unavailableCapability('请把上传的附件翻译成中文')?.type).toBe(
      'translation',
    );
  });
  it('保留原有费用分析与票据办理的路由', () => {
    expect(unavailableCapability('分析10月费用')).toBeNull();
    expect(unavailableCapability('整理这批发票')).toBeNull();
  });
  it('未接入能力的续问沿用当前上下文，不返回无关的费用结果', () => {
    expect(unavailableCapability('继续分析付款条款', 'contract')?.type).toBe(
      'contract',
    );
    expect(unavailableCapability('翻成中文', 'translation')?.type).toBe(
      'translation',
    );
    expect(unavailableCapability('收款方是示例公司', 'receipt')?.type).toBe(
      'receipt',
    );
  });
  it('明确切换到已支持的事项后可以使用对应能力', () => {
    expect(
      unavailableCapability('改为分析10月集团报销费用', 'contract'),
    ).toBeNull();
    expect(unavailableCapability('分析10月各部门费用', 'contract')).toBeNull();
  });
});
