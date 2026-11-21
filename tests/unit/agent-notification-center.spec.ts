import { describe, expect, it } from 'vitest';
import { buildWorkspaceNotifications } from '../../apps/web/src/demos/agent-workspace/notification-center-model';
import type {
  ChatMessage,
  Task,
} from '../../apps/web/src/demos/agent-workspace/workspace';

function task(
  id: string,
  messages: ChatMessage[],
  extra: Partial<Task> = {},
): Task {
  return {
    id,
    title: id,
    status: '已完成',
    type: 'chat',
    messages,
    input: '',
    refs: [],
    updated: '刚刚',
    ...extra,
  };
}

function assistant(
  id: string,
  createdAt?: number,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: 'assistant',
    text: '已核查待办单据。',
    createdAt,
    ...extra,
  };
}

describe('workspace notification center', () => {
  it('only includes real results and distinguishes automatic task conversations', () => {
    const tasks = [
      task('legacy', [assistant('old')]),
      task('scheduled-chat-123', [assistant('automation', 2000)]),
      task(
        'running',
        [assistant('stream', 3000, { runId: 'run1', runStatus: 'running' })],
        { activeRunId: 'run1' },
      ),
      task('draft', []),
    ];
    const readReplies = new Map([['legacy', 'old']]);
    expect(buildWorkspaceNotifications({ tasks, readReplies })).toMatchObject([
      {
        taskId: 'scheduled-chat-123',
        kind: 'automation',
        unread: true,
        timestamp: 2000,
      },
      { taskId: 'legacy', kind: 'reply', unread: false, timestamp: null },
    ]);
  });

  it('uses the latest valid unanswered question and drops it once the draft changes', () => {
    const question = {
      id: 'question',
      title: '请选择要报销的单据',
      status: 'pending' as const,
      options: [],
      multiple: false,
      draftId: 'draft-1',
      draftVersion: 1,
    };
    const tasks = [
      task('task-1', [
        assistant('question-reply', 2000, { text: '', question }),
      ]),
    ];
    const readReplies = new Map([['task-1', 'question-reply']]);
    const data = {
      submissions: { drafts: { 'draft-1': { version: 1, status: 'draft' } } },
    };
    expect(
      buildWorkspaceNotifications({ tasks, data, readReplies }),
    ).toMatchObject([
      {
        kind: 'confirmation',
        detail: question.title,
        unread: true,
        replyId: 'question-reply',
      },
    ]);
    expect(buildWorkspaceNotifications({ tasks, readReplies })).toEqual([]);
  });

  it('acknowledges a run failure without sharing its raw error and alerts again after another failure', () => {
    const tasks = [
      task(
        'task-1',
        [
          assistant('past-reply', 1000),
          assistant('failure-1', 2000, {
            text: 'internal connection failure',
            runStatus: 'failed',
          }),
        ],
        { status: '执行失败' },
      ),
    ];
    const items = buildWorkspaceNotifications({ tasks });
    expect(items).toMatchObject([
      { kind: 'error', unread: true, replyId: 'past-reply' },
    ]);
    expect(items[0]?.detail).not.toContain('internal');
    const readIds = new Set([items[0]!.id]);
    expect(buildWorkspaceNotifications({ tasks, readIds })[0]?.unread).toBe(
      false,
    );

    const retry = assistant('failure-2', 3000, { runStatus: 'failed' });
    const retriedTasks = [
      task('task-1', [...tasks[0]!.messages, retry], { status: '执行失败' }),
    ];
    expect(
      buildWorkspaceNotifications({ tasks: retriedTasks, readIds })[0]?.unread,
    ).toBe(true);
  });
});
