import { useEffect, useState } from 'react';
import { hasUnreadReply, latestReplyId } from './conversation-model';
import type { Task } from './workspace';

const initializedKey = 'cx.agent.read-replies.v1';
const taskKeyPrefix = initializedKey + '.';

function loadReads(): Map<string, string> | null {
  try {
    if (!localStorage.getItem(initializedKey)) return null;
    const reads = new Map<string, string>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(taskKeyPrefix)) continue;
      const reply = localStorage.getItem(key);
      if (reply) reads.set(key.slice(taskKeyPrefix.length), reply);
    }
    return reads;
  } catch {
    return null;
  }
}

export function useConversationReads(
  ready: boolean,
  tasks: Task[],
  openTask?: Task,
) {
  const [reads, setReads] = useState(loadReads);
  const [visible, setVisible] = useState(() => !document.hidden);

  function markRepliesRead(replies: ReadonlyMap<string, string>) {
    if (!reads || !replies.size) return;
    const next = new Map(reads);
    const latestTasks = new Map(tasks.map((task) => [task.id, task]));
    for (const [id, reply] of replies) {
      const task = latestTasks.get(id);
      if (!task || !hasUnreadReply(task, next.get(id) ?? null, reply)) continue;
      const key = taskKeyPrefix + id;
      let marker = reply;
      try {
        const stored = localStorage.getItem(key);
        if (stored && !hasUnreadReply(task, stored, reply)) marker = stored;
        else localStorage.setItem(key, reply);
      } catch {
        /* Reading still works for this page session. */
      }
      next.set(id, marker);
    }
    setReads(next);
  }

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    const onStorage = (event: StorageEvent) => {
      if (
        event.key === null ||
        event.key === initializedKey ||
        event.key.startsWith(taskKeyPrefix)
      ) {
        setReads(loadReads());
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!reads) {
      // Existing history establishes the baseline on first use of this browser.
      const baseline = new Map<string, string>();
      for (const task of tasks) {
        const reply = latestReplyId(task);
        if (reply) baseline.set(task.id, reply);
      }
      try {
        for (const [id, reply] of baseline)
          localStorage.setItem(taskKeyPrefix + id, reply);
        localStorage.setItem(initializedKey, '1');
      } catch {
        /* Keep the baseline in memory if storage is unavailable. */
      }
      setReads(baseline);
      return;
    }
    if (!visible || !openTask) return;
    const reply = latestReplyId(openTask);
    if (
      !reply ||
      !hasUnreadReply(openTask, reads.get(openTask.id) ?? null, reply)
    )
      return;
    markRepliesRead(new Map([[openTask.id, reply]]));
  }, [ready, tasks, openTask, visible, reads]);

  return { reads, markRepliesRead };
}
