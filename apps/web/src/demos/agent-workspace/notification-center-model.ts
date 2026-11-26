import { useEffect, useState } from 'react';
import {
  hasUnreadReply,
  lastMessageTime,
  latestReplyId,
  recentConversationAlert,
} from './conversation-model';
import { pendingQuestion, questionState } from './question-model';
import { messageInline, parseMessageMarkdown } from './message-markdown';
import { visibleMessageCards } from './submission-conversation';
import type { ChatMessage, Task, WorkspaceState } from './workspace';

export type NotificationKind =
  'confirmation' | 'error' | 'reply' | 'automation';

export interface WorkspaceNotification {
  id: string;
  taskId: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  timestamp: number | null;
  unread: boolean;
  replyId: string | null;
}

interface NotificationSource {
  tasks: Task[];
  data?: WorkspaceState['data'];
  readReplies?: ReadonlyMap<string, string> | null;
}

function preview(text: string): string {
  const blocks = parseMessageMarkdown(text).filter((block) => block.kind !== 'hr');
  const summary = blocks.slice(0, 2).map((block) => {
    if (block.kind === 'list') return block.items.join(' ');
    if (block.kind === 'table') return block.header.join(' · ');
    return block.text;
  }).join(' ');
  const line = messageInline(summary).map((token) => token.text).join('').trim().replace(/\s+/g, ' ');
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function notificationTime(task: Task, message?: ChatMessage): number | null {
  if (
    typeof message?.createdAt === 'number' &&
    Number.isFinite(new Date(message.createdAt).getTime())
  )
    return message.createdAt;
  return message && message === task.messages.at(-1)
    ? lastMessageTime(task)
    : null;
}

export function buildWorkspaceNotifications({
  tasks,
  data = {},
  readReplies,
  readIds,
}: NotificationSource & {
  readIds?: ReadonlySet<string>;
}): WorkspaceNotification[] {
  const items: WorkspaceNotification[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const replyId = latestReplyId(task);
    const add = (
      kind: NotificationKind,
      eventId: string,
      detail: string,
      message?: ChatMessage,
    ) => {
      const id = JSON.stringify([task.id, kind, eventId]);
      const unread =
        (kind === 'confirmation' ||
          kind === 'error' ||
          (!!readReplies &&
            hasUnreadReply(task, readReplies.get(task.id) ?? null, replyId))) &&
        !readIds?.has(id);
      items.push({
        id,
        taskId: task.id,
        kind,
        title: task.title,
        detail: preview(detail),
        timestamp: notificationTime(task, message),
        unread,
        replyId,
      });
    };

    const question = pendingQuestion(task);
    if (question && questionState(question, data) === 'pending') {
      const message = task.messages.find(
        (item) => item.question?.id === question.id,
      );
      add('confirmation', question.id, question.title, message);
      continue;
    }
    if (recentConversationAlert(task, null) === 'error') {
      const message = task.messages.at(-1);
      add(
        'error',
        message?.runId ?? message?.id ?? task.status,
        '本次办理未完成，请查看会话。',
        message,
      );
      continue;
    }
    const reply =
      replyId && task.messages.find((message) => message.id === replyId);
    if (!reply || reply.question) continue;
    const detail =
      reply.text.trim() || visibleMessageCards(reply)[0]?.card.title;
    if (!detail) continue;
    const kind = task.id.startsWith('scheduled-chat-') ? 'automation' : 'reply';
    add(kind, reply.id, detail, reply);
  }
  return items.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0;
    if (a.timestamp === null) return 1;
    if (b.timestamp === null) return -1;
    return b.timestamp - a.timestamp;
  });
}

const keyPrefix = 'cx.agent.notification-read.v1.';

function loadReadIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(keyPrefix)) ids.add(key.slice(keyPrefix.length));
    }
  } catch {
    // A session can still mark notifications read without browser storage.
  }
  return ids;
}

export function useWorkspaceNotifications({
  ready,
  openTaskId,
  ...source
}: NotificationSource & { ready: boolean; openTaskId?: string | null }) {
  const [readIds, setReadIds] = useState(loadReadIds);
  const [visible, setVisible] = useState(() => !document.hidden);
  const items = ready
    ? buildWorkspaceNotifications({ ...source, readIds })
    : [];

  function markIds(ids: string[]) {
    if (ids.length === 0) return;
    try {
      for (const id of ids) localStorage.setItem(keyPrefix + id, '1');
    } catch {
      // Keep this page's read state when browser storage is unavailable.
    }
    setReadIds((current) => new Set([...current, ...ids]));
  }

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith(keyPrefix))
        setReadIds(loadReadIds());
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const openNotification = visible
    ? items.find((item) => item.unread && item.taskId === openTaskId)
    : undefined;
  const openNotificationId = openNotification?.id;
  useEffect(() => {
    if (openNotificationId) markIds([openNotificationId]);
  }, [openNotificationId]);

  return {
    items,
    markRead: (id: string) => markIds([id]),
    markAllRead: () =>
      markIds(items.filter((item) => item.unread).map((item) => item.id)),
  };
}
