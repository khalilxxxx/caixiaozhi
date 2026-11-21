import { useRef, useState } from 'react';
import { formatConversationTime } from './conversation-model';
import type { WorkspaceNotification } from './notification-center-model';
import { Icon } from './ui';
import './notification-center.css';

const notificationTypes: Record<WorkspaceNotification['kind'], { icon: string; label: string }> = {
  confirmation: { icon: 'help', label: '待确认' },
  error: { icon: 'error-circle', label: '办理异常' },
  reply: { icon: 'chat', label: '小智回复' },
  automation: { icon: 'clock', label: '自动化' },
};

type NotificationCenterProps = {
  items: WorkspaceNotification[];
  refreshFailed: boolean;
  onRefresh: () => void;
  onOpen: (item: WorkspaceNotification) => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onClose: () => void;
};

export function NotificationCenter({
  items,
  refreshFailed,
  onRefresh,
  onOpen,
  onMarkRead,
  onMarkAllRead,
  onClose,
}: NotificationCenterProps) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const unread = items.filter((item) => item.unread);
  const visible = unreadOnly ? unread : items;

  function focusFilter() {
    filterRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }

  return (
    <section className="notification-center" id="workspace-notifications" aria-labelledby="notification-center-heading">
      <header className="notification-center-header">
        <h1 id="notification-center-heading" tabIndex={-1}>消息中心</h1>
        <button type="button" className="icon-btn" aria-label="关闭消息中心" title="关闭消息中心" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="notification-center-toolbar">
        <div className="notification-filters" role="group" aria-label="消息筛选" ref={filterRef}>
          <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>全部</button>
          <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
            未读
            {unread.length > 0 && <span className="notification-count">{unread.length}</span>}
          </button>
        </div>
        <button
          type="button"
          className="notification-action"
          disabled={!unread.length}
          onClick={() => {
            focusFilter();
            onMarkAllRead();
          }}
        >
          全部已读
        </button>
      </div>
      {refreshFailed && (
        <div className="notification-refresh-error">
          <span role="status">消息暂未更新</span>
          <button
            type="button"
            className="notification-action"
            onClick={() => {
              focusFilter();
              onRefresh();
            }}
          >
            重试
          </button>
        </div>
      )}
      {visible.length ? (
        <ul className="notification-list" aria-label={unreadOnly ? '未读消息' : '全部消息'}>
          {visible.map((item) => {
            const type = notificationTypes[item.kind];
            return (
              <li className="notification-item" key={item.id}>
                <button
                  type="button"
                  className="notification-open"
                  onClick={() => onOpen(item)}
                >
                  <span className="notification-type-icon" data-kind={item.kind}>
                    <Icon name={type.icon} size={18} />
                  </span>
                  <span className="notification-copy">
                    <span className="notification-title">
                      {item.unread && <span className="notification-unread-dot"><span className="sr-only">未读</span></span>}
                      <strong title={item.title}>{item.title}</strong>
                    </span>
                    {item.detail && <span className="notification-detail">{item.detail}</span>}
                    <span className="notification-meta">
                      <span>{type.label}</span>
                      {item.timestamp !== null && (
                        <time dateTime={new Date(item.timestamp).toISOString()} title={new Date(item.timestamp).toLocaleString('zh-CN')}>
                          {formatConversationTime(item.timestamp)}
                        </time>
                      )}
                    </span>
                  </span>
                  <Icon className="notification-chevron" name="chevron" size={15} />
                </button>
                {item.unread && (
                  <button
                    type="button"
                    className="icon-btn notification-mark"
                    aria-label={`将「${item.title}」标为已读`}
                    title="标为已读"
                    onClick={(event) => {
                      if (unreadOnly) focusFilter();
                      else event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.notification-open')?.focus();
                      onMarkRead(item.id);
                    }}
                  >
                    <Icon name="check" size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : refreshFailed ? null : (
        <div className="notification-empty" role="status">
          <Icon name="bell" size={24} />
          <p>{unreadOnly ? '暂无未读消息' : '暂无消息'}</p>
        </div>
      )}
    </section>
  );
}
