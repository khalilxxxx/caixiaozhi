import { useRef, useState } from 'react';
import {
  conversationState,
  formatConversationTime,
  lastMessageTime,
  recentConversations,
} from './conversation-model';
import { Icon } from './ui';
import type { Task } from './workspace';

function conversationPreview(task: Task): string {
  const draft = task.input.trim();
  const latest = task.messages.at(-1);
  const text = draft
    ? `草稿：${draft}`
    : latest?.text.trim() ||
      latest?.cards?.map((card) => card.title).join('、') ||
      task.refs.map((ref) => ref.title).join('、');
  const singleLine = text.replace(/\s+/g, ' ');
  return singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
}

export function ConversationHistory({
  tasks,
  onSelect,
}: {
  tasks: Task[];
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const conversations = recentConversations(tasks);
  const results = normalizedQuery
    ? conversations.filter((task) =>
        [
          task.title,
          task.input,
          ...task.messages.map((message) => message.text),
        ].some((text) => text.toLocaleLowerCase().includes(normalizedQuery)),
      )
    : conversations;

  return (
    <>
      <div className="history-toolbar">
        <div className="history-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            autoFocus
            type="search"
            aria-label="搜索历史会话"
            placeholder="搜索会话标题或内容"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              <Icon name="close" size={15} />
            </button>
          )}
        </div>
        <span className="history-count" aria-live="polite">
          {results.length} 个会话
        </span>
      </div>
      {results.length ? (
        <div className="history-list">
          {results.map((task) => {
            const status = conversationState(task);
            const time = lastMessageTime(task);
            const preview = conversationPreview(task);
            return (
              <button
                type="button"
                key={task.id}
                className="history-row"
                onClick={() => onSelect(task.id)}
              >
                <span className="history-row-copy">
                  <span className="history-row-title">
                    {task.title === '新任务' ? '新会话' : task.title}
                  </span>
                  {preview && (
                    <span className="history-row-preview">{preview}</span>
                  )}
                </span>
                <span className="history-row-meta">
                  {time !== null && (
                    <time
                      dateTime={new Date(time).toISOString()}
                      title={new Date(time).toLocaleString('zh-CN')}
                    >
                      {formatConversationTime(time)}
                    </time>
                  )}
                  <span
                    className={`conversation-state ${status.tone}`}
                    title={status.label}
                    aria-label={status.label}
                  >
                    <Icon name={status.icon} size={15} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="history-empty">
          {conversations.length ? '未找到相关会话' : '暂无会话'}
        </div>
      )}
    </>
  );
}
