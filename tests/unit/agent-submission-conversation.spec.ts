import { describe, expect, it } from 'vitest';
import {
  conversationDraft,
  isSubmissionFollowUp,
  latestSubmissionCards,
} from '../../apps/web/src/demos/agent-workspace/submission-conversation';
import type { Task } from '../../apps/web/src/demos/agent-workspace/workspace';

function task(): Task {
  return {
    id: 'task',
    title: '申请',
    type: 'submission',
    status: '待我补充',
    input: '',
    refs: [],
    updated: '',
    messages: [
      {
        id: 'first',
        role: 'assistant',
        text: '',
        cards: [{ kind: 'submission', id: 'travel', title: '差旅申请' }],
      },
    ],
  };
}

describe('智能提单会话上下文', () => {
  it('增量修改保留已有单据类型', () => {
    expect(conversationDraft('返程改到11月26日', task(), [])).toBe('travel');
    const personal = task();
    personal.messages[0]!.cards![0]!.id = 'personal';
    expect(conversationDraft('事由改为部门聚餐', personal, [])).toBe(
      'personal',
    );
  });
  it('明确的新单据类型优先于旧会话与引用', () => {
    expect(
      conversationDraft('填写个人费用报销', task(), [
        { kind: 'submission', id: 'travel', title: '差旅申请' },
      ]),
    ).toBe('personal');
    expect(conversationDraft('填写差旅报销', task(), [])).toBe('expense');
  });
  it('明确引用优先于历史卡片', () => {
    expect(
      conversationDraft('事由改为客户拜访', task(), [
        { kind: 'submission', id: 'personal', title: '个人费用报销' },
      ]),
    ).toBe('personal');
  });
  it('新加入的提单引用优先于遗留引用', () => {
    expect(
      conversationDraft('事由改为部门聚餐', task(), [
        { kind: 'submission', id: 'travel', title: '差旅申请' },
        { kind: 'submission', id: 'personal', title: '个人费用报销' },
      ]),
    ).toBe('personal');
  });
  it('包含申请的出差费用报销仍进入报销单', () => {
    expect(conversationDraft('我要申请出差费用报销', task(), [])).toBe(
      'expense',
    );
  });
  it('修改事由中的单据名称不会切换当前草稿', () => {
    expect(conversationDraft('事由改为客户报销系统调研', task(), [])).toBe(
      'travel',
    );
  });
  it('初次自然语言行程进入差旅申请', () => {
    const initial = { ...task(), type: 'chat', messages: [] };
    expect(
      conversationDraft('11月23日从杭州去北京拜访客户，25日返回', initial, []),
    ).toBe('travel');
    expect(conversationDraft('申请报销餐费', initial, [])).toBe('expense');
  });
  it('无提单上下文不把一般修改当作提单', () => {
    expect(isSubmissionFollowUp('事由改为客户拜访', task(), [])).toBe(true);
    expect(
      isSubmissionFollowUp('改为上个月', { ...task(), type: 'analysis' }, []),
    ).toBe(false);
    expect(isSubmissionFollowUp('查看规则中心', task(), [])).toBe(false);
  });
  it('仅保留每种单据最后一张卡片为可操作版本', () => {
    const conversation = task();
    conversation.messages.push({
      id: 'second',
      role: 'assistant',
      text: '',
      cards: [
        { kind: 'submission', id: 'travel', title: '差旅申请' },
        { kind: 'submission', id: 'personal', title: '个人费用报销' },
      ],
    });
    expect([...latestSubmissionCards(conversation)]).toEqual([
      'second:0',
      'second:1',
    ]);
    expect(conversation.messages[0]!.cards![0]!.title).toBe('差旅申请');
  });
});
