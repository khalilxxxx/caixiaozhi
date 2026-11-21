import type { Task } from './workspace';
import { needsAttention } from './task-model';
import { getCapability } from './capability-model';
import { visibleMessageCards } from './submission-conversation';

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(new Date(value).getTime())
  );
}

function absoluteTime(value: string): number | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  // Date.parse normalizes impossible calendar dates such as February 30.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day)
  )
    return null;
  const timestamp = Date.parse(value.trim().replace(' ', 'T'));
  return isTimestamp(timestamp) ? timestamp : null;
}

export function lastMessageTime(task: Task): number | null {
  const message = task.messages.at(-1);
  if (!message) return null;
  if (isTimestamp(message.createdAt)) return message.createdAt;
  return absoluteTime(task.updated);
}

export function formatConversationTime(
  timestamp: number | null,
  now = Date.now(),
): string {
  if (!isTimestamp(timestamp) || !isTimestamp(now)) return '';
  const date = new Date(timestamp);
  const current = new Date(now);
  const elapsed = now - timestamp;
  if (date.toDateString() === current.toDateString() && elapsed >= 0) {
    if (elapsed < 60000) return '刚刚';
    if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} 分钟前`;
    return `${Math.floor(elapsed / 3600000)} 小时前`;
  }
  const yesterday = new Date(current);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  const year =
    date.getFullYear() === current.getFullYear()
      ? ''
      : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

export function conversationState(task: Task): {
  icon: string;
  label: string;
  tone: string;
} {
  const label = task.status;
  if (/失败|错误|异常/.test(label))
    return { icon: 'alert', label, tone: 'red' };
  if (needsAttention(task)) return { icon: 'alert', label, tone: 'amber' };
  if (/等待|待审批|待回执|待来源|排队中/.test(label))
    return { icon: 'clock', label, tone: 'neutral' };
  if (/处理中|执行中|运行中|同步中|生成中|分析中|检索中/.test(label))
    return { icon: 'clock', label, tone: 'blue' };
  if (/已完成|已办结/.test(label) || label === '完成')
    return { icon: 'check', label, tone: 'green' };
  return { icon: 'chat', label, tone: 'neutral' };
}

const deliveredRunStates = new Set([
  'completed',
  'succeeded',
  'awaiting_input',
  'waiting',
]);
const failedRunStates = new Set(['failed', 'interrupted', 'incomplete']);

export function latestReplyId(task: Task): string | null {
  for (let index = task.messages.length - 1; index >= 0; index--) {
    const message = task.messages[index]!;
    if (message.role !== 'assistant') continue;
    // Streaming and final representations share an ID. Only delivery advances the read marker.
    if (message.runStatus && !deliveredRunStates.has(message.runStatus))
      continue;
    if (task.activeRunId && message.runId === task.activeRunId) continue;
    if (
      message.text.trim() ||
      message.question?.title ||
      visibleMessageCards(message).length
    )
      return message.id;
  }
  return null;
}

export function hasUnreadReply(
  task: Task,
  lastReadId: string | null,
  latestId = latestReplyId(task),
): boolean {
  if (!latestId || latestId === lastReadId) return false;
  if (!lastReadId) return true;
  // Another tab can have read a newer snapshot, including this run's final reply.
  const readIndex = task.messages.findIndex(
    (message) => message.id === lastReadId,
  );
  return (
    readIndex >= 0 &&
    task.messages.findIndex((message) => message.id === latestId) > readIndex
  );
}

export function recentConversationAlert(
  task: Task,
  lastReadId: string | null,
): 'error' | 'unread' | null {
  const last = task.messages.at(-1);
  const latestRun = last?.role === 'assistant' ? last.runStatus : undefined;
  const failed = latestRun
    ? failedRunStates.has(latestRun)
    : /失败|错误|异常|中断|未完成/.test(task.status);
  if (failed && !task.activeRunId && task.status !== '处理中') return 'error';
  return hasUnreadReply(task, lastReadId) ? 'unread' : null;
}

export function recentConversations(tasks: Task[]): Task[] {
  const seen = new Set<string>();
  return tasks
    .filter((task) => {
      if (seen.has(task.id)) return false;
      const hasContent =
        task.messages.some(
          (message) =>
            message.text.trim() ||
            message.cards?.length ||
            message.question?.title,
        ) ||
        task.input.trim() ||
        task.refs.length ||
        !!getCapability(task.capability);
      if (!hasContent) return false;
      seen.add(task.id);
      return true;
    })
    .map((task, index) => ({ task, index, timestamp: lastMessageTime(task) }))
    .sort((a, b) => {
      if (a.timestamp === b.timestamp) return a.index - b.index;
      if (a.timestamp === null) return 1;
      if (b.timestamp === null) return -1;
      return b.timestamp - a.timestamp;
    })
    .map(({ task }) => task);
}
