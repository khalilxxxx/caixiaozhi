import type { Task } from './workspace';

export function needsAttention(task: Task): boolean {
  return /待我|待你回答|暂停/.test(task.status);
}

export function selectHomeTasks(tasks: Task[]): {
  attention: Task[];
  ongoing: Task[];
} {
  const attention: Task[] = [];
  const ongoing: Task[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (needsAttention(task)) {
      attention.push(task);
      continue;
    }
    const hasContent =
      task.messages.some(
        (message) => message.text.trim() || message.cards?.length,
      ) ||
      task.input.trim() ||
      task.refs.length;
    if (
      hasContent &&
      /处理中|等待|待回执|待来源|同步中|排队中/.test(task.status)
    )
      ongoing.push(task);
  }
  return { attention, ongoing };
}

export function appendDraft(current: string, prepared: string): string {
  if (!current.trim()) return prepared;
  if (current.trimEnd().endsWith(prepared)) return current;
  return `${current}${current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'}${prepared}`;
}
