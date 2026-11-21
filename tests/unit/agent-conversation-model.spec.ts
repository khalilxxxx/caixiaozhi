import { describe, expect, it } from 'vitest';
import type { Task } from '../../apps/web/src/demos/agent-workspace/workspace';
import {
  conversationState,
  formatConversationTime,
  hasUnreadReply,
  latestReplyId,
  lastMessageTime,
  recentConversationAlert,
  recentConversations,
} from '../../apps/web/src/demos/agent-workspace/conversation-model';

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `会话 ${id}`,
    status: '待开始',
    type: 'chat',
    messages: [{ id: `${id}-message`, role: 'user', text: '查询办理进度' }],
    input: '',
    refs: [],
    updated: '刚刚',
    ...extra,
  };
}

function timestampedTask(id: string, createdAt: number): Task {
  return task(id, {
    messages: [{ id: `${id}-message`, role: 'user', text: id, createdAt }],
  });
}

describe('conversation message time', () => {
  it('uses the final message timestamp instead of task updates or earlier messages', () => {
    const conversation = task('final', {
      updated: '2026-11-16T09:00:00+08:00',
      messages: [
        { id: 'first', role: 'user', text: '提问', createdAt: 2000 },
        { id: 'last', role: 'assistant', text: '回答', createdAt: 1000 },
      ],
    });
    expect(lastMessageTime(conversation)).toBe(1000);
  });

  it('uses an absolute legacy update time only when the final message has no timestamp', () => {
    expect(
      lastMessageTime(task('legacy', { updated: '2026-11-16T10:12:00+08:00' })),
    ).toBe(1794795120000);
  });

  it.each([
    '刚刚',
    '今天 10:12',
    '昨天 17:46',
    '10:12',
    '11-16',
    '2026-02-30T10:00:00Z',
  ])('does not invent an absolute message time from %s', (updated) => {
    expect(lastMessageTime(task('legacy', { updated }))).toBeNull();
  });

  it('does not use an earlier timestamp when the final message time is unknown', () => {
    expect(
      lastMessageTime(
        task('unknown', {
          messages: [
            { id: 'first', role: 'user', text: '提问', createdAt: 1000 },
            { id: 'last', role: 'assistant', text: '回答' },
          ],
        }),
      ),
    ).toBeNull();
  });

  it('keeps a draft without messages undated even when the task has an update time', () => {
    expect(
      lastMessageTime(
        task('draft', {
          messages: [],
          input: '尚未发送',
          updated: '2026-11-16T10:12:00+08:00',
        }),
      ),
    ).toBeNull();
  });

  it('rejects invalid numeric timestamps but accepts the Unix epoch', () => {
    expect(lastMessageTime(timestampedTask('epoch', 0))).toBe(0);
    expect(lastMessageTime(timestampedTask('invalid', Number.NaN))).toBeNull();
    expect(lastMessageTime(timestampedTask('overflow', 1e20))).toBeNull();
  });
});

describe('conversation time labels', () => {
  const now = new Date(2026, 10, 16, 12, 0, 0).getTime();

  it('keeps unknown or invalid times empty', () => {
    expect(formatConversationTime(null, now)).toBe('');
    expect(formatConversationTime(Number.NaN, now)).toBe('');
  });

  it.each([
    [now, '刚刚'],
    [now - 59000, '刚刚'],
    [now - 60000, '1 分钟前'],
    [now - 59 * 60000, '59 分钟前'],
    [now - 60 * 60000, '1 小时前'],
    [now - 3 * 3600000, '3 小时前'],
  ])('formats recent message time %s as %s', (timestamp, label) => {
    expect(formatConversationTime(timestamp, now)).toBe(label);
  });

  it('uses calendar yesterday even when less than an hour has elapsed', () => {
    expect(
      formatConversationTime(
        new Date(2026, 10, 15, 23, 50).getTime(),
        new Date(2026, 10, 16, 0, 10).getTime(),
      ),
    ).toBe('昨天');
  });

  it('shows older dates and includes the year when it differs', () => {
    expect(
      formatConversationTime(new Date(2026, 10, 14, 18).getTime(), now),
    ).toBe('11月14日');
    expect(
      formatConversationTime(new Date(2025, 11, 31, 18).getTime(), now),
    ).toBe('2025年12月31日');
  });

  it('does not describe a future date as a recent past message', () => {
    expect(
      formatConversationTime(new Date(2026, 10, 17, 12).getTime(), now),
    ).toBe('11月17日');
  });
});

describe('conversation state', () => {
  it.each(['处理中', '执行中', '同步中'])(
    'marks %s as active execution',
    (status) => {
      expect(conversationState(task('running', { status }))).toEqual({
        icon: 'clock',
        label: status,
        tone: 'blue',
      });
    },
  );

  it.each(['待我确认', '待我补充', '已暂停'])(
    'marks %s as requiring attention',
    (status) => {
      expect(conversationState(task('attention', { status }))).toEqual({
        icon: 'alert',
        label: status,
        tone: 'amber',
      });
    },
  );

  it.each(['等待审批', '待回执', '待来源返回', '排队中'])(
    'keeps %s distinct from active execution',
    (status) => {
      expect(conversationState(task('waiting', { status }))).toEqual({
        icon: 'clock',
        label: status,
        tone: 'neutral',
      });
    },
  );

  it('distinguishes failures, completion, and ordinary chat', () => {
    expect(conversationState(task('failed', { status: '执行失败' }))).toEqual({
      icon: 'alert',
      label: '执行失败',
      tone: 'red',
    });
    expect(conversationState(task('done', { status: '已完成' }))).toEqual({
      icon: 'check',
      label: '已完成',
      tone: 'green',
    });
    expect(conversationState(task('chat'))).toEqual({
      icon: 'chat',
      label: '待开始',
      tone: 'neutral',
    });
  });
});

describe('recent conversation alerts', () => {
  const previous = {
    id: 'answer-1',
    role: 'assistant' as const,
    text: '第一份清单',
  };
  const next = {
    id: 'answer-2',
    role: 'assistant' as const,
    text: '第二份清单',
  };

  it('does not redisplay or roll back a read marker when a stale snapshot is replayed', () => {
    const older = task('stale', { messages: [previous] });
    expect(hasUnreadReply(older, next.id)).toBe(false);
    const placeholder = task('stale', {
      messages: [previous, { ...next, runStatus: 'running' }],
    });
    expect(hasUnreadReply(placeholder, next.id)).toBe(false);
    expect(recentConversationAlert(placeholder, next.id)).toBeNull();
  });

  it('marks new replies once, independently of updated timestamps and task completion', () => {
    const completed = task('completed', {
      status: '已完成',
      messages: [previous, next],
    });
    expect(latestReplyId(completed)).toBe(next.id);
    expect(recentConversationAlert(completed, previous.id)).toBe('unread');
    expect(
      recentConversationAlert({ ...completed, updated: '其他时间' }, next.id),
    ).toBeNull();
  });

  it('ignores user messages, in-progress text and activity without a delivered reply', () => {
    const streaming = task('streaming', {
      status: '处理中',
      messages: [
        previous,
        { id: 'user-2', role: 'user', text: '请重新查询' },
        { ...next, runStatus: 'running' },
      ],
    });
    expect(latestReplyId(streaming)).toBe(previous.id);
    expect(recentConversationAlert(streaming, previous.id)).toBeNull();
    expect(
      latestReplyId({
        ...streaming,
        messages: [{ ...next, text: '', runStatus: 'completed' }],
      }),
    ).toBeNull();
    expect(recentConversationAlert(task('user-only'), null)).toBeNull();
  });

  it('delivers result cards and questions, including answers persisted without text', () => {
    const result = {
      ...next,
      text: '',
      runStatus: 'completed',
      cards: [{ kind: 'submission', title: '差旅草稿' }],
    };
    expect(latestReplyId(task('cards', { messages: [previous, result] }))).toBe(
      next.id,
    );
    expect(
      latestReplyId(
        task('hidden', {
          messages: [previous, { ...result, submissionPhase: 'collecting' }],
        }),
      ),
    ).toBe(previous.id);
    const question = task('question', {
      messages: [
        {
          ...next,
          text: '',
          question: {
            id: 'q',
            title: '本次出差前往哪里？',
            options: [],
            status: 'pending',
            multiple: false,
          },
          runStatus: 'awaiting_input',
        },
      ],
    });
    expect(recentConversations([question])).toEqual([question]);
    expect(recentConversationAlert(question, null)).toBe('unread');
    expect(recentConversationAlert(question, next.id)).toBeNull();
  });

  it.each(['待你回答', '待我确认', '已暂停', '已完成', '等待审批', '待回执'])(
    'does not alert for the status label %s by itself',
    (status) =>
      expect(
        recentConversationAlert(task('status', { status }), null),
      ).toBeNull(),
  );

  it.each(['failed', 'interrupted', 'incomplete'])(
    'shows a current %s run before unread replies',
    (runStatus) => {
      const failed = task('failed', {
        messages: [previous, { ...next, runStatus }],
      });
      expect(latestReplyId(failed)).toBe(previous.id);
      expect(recentConversationAlert(failed, null)).toBe('error');
      expect(recentConversationAlert(failed, previous.id)).toBe('error');
      expect(
        recentConversationAlert(task('legacy', { status: '执行失败' }), null),
      ).toBe('error');
    },
  );

  it('clears historical failures after a retry and keeps voluntary stops quiet', () => {
    const failure = { ...previous, runStatus: 'failed' };
    expect(
      recentConversationAlert(
        task('retry', { activeRunId: 'new-run', messages: [failure] }),
        null,
      ),
    ).toBeNull();
    expect(
      recentConversationAlert(
        task('starting', { status: '处理中', messages: [failure] }),
        null,
      ),
    ).toBeNull();
    expect(
      recentConversationAlert(
        task('done', {
          status: '执行失败',
          messages: [failure, { ...next, runStatus: 'completed' }],
        }),
        next.id,
      ),
    ).toBeNull();
    expect(
      recentConversationAlert(
        task('stopped', {
          status: '已暂停',
          messages: [failure, { ...next, runStatus: 'cancelled' }],
        }),
        null,
      ),
    ).toBeNull();
  });
});

describe('recent conversations', () => {
  it('sorts by the final message time and keeps unknown times stable at the end', () => {
    const conversations = [
      task('unknown-first'),
      timestampedTask('older', 1000),
      task('unknown-second'),
      timestampedTask('newest', 3000),
      timestampedTask('same-time', 3000),
      timestampedTask('middle', 2000),
    ];
    const original = [...conversations];
    expect(recentConversations(conversations).map((item) => item.id)).toEqual([
      'newest',
      'same-time',
      'middle',
      'older',
      'unknown-first',
      'unknown-second',
    ]);
    expect(conversations).toEqual(original);
  });

  it('excludes blank conversations but preserves drafts, references, and result cards', () => {
    const conversations = [
      task('empty', { messages: [] }),
      task('whitespace', {
        messages: [{ id: 'blank', role: 'user', text: '  ' }],
        input: '\n ',
      }),
      task('draft', { messages: [], input: '待发送的请求' }),
      task('reference', {
        messages: [],
        refs: [{ kind: 'document', id: 'D1', title: '单据' }],
      }),
      task('card', {
        messages: [
          {
            id: 'result',
            role: 'assistant',
            text: '',
            cards: [{ kind: 'result', title: '处理结果' }],
          },
        ],
      }),
    ];
    expect(recentConversations(conversations).map((item) => item.id)).toEqual([
      'draft',
      'reference',
      'card',
    ]);
  });

  it('deduplicates IDs using the first nonempty conversation', () => {
    const current = timestampedTask('same', 2000);
    expect(
      recentConversations([
        task('same', { messages: [] }),
        current,
        timestampedTask('same', 3000),
      ]),
    ).toEqual([current]);
    expect(recentConversations([])).toEqual([]);
  });

  it('preserves a draft with only a valid selected capability', () => {
    const selected = task('selected', {
      messages: [],
      capability: 'submission',
    });
    expect(recentConversations([selected])).toEqual([selected]);
  });

  it('excludes blank conversations with cleared or unknown capabilities', () => {
    const cleared = task('cleared', { messages: [], capability: null });
    const unknown = task('unknown', {
      messages: [],
      capability: 'removed-capability' as Task['capability'],
    });
    expect(recentConversations([cleared, unknown])).toEqual([]);
  });
});
