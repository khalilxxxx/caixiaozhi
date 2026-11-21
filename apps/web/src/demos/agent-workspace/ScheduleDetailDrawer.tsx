import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MessageText } from './MessageText';
import { api } from './runtime-client';
import { Badge, Button, Icon } from './ui';
import {
  errorText,
  planLabel,
  RunBadge,
  scheduleStateLabel,
  timestamp,
  type Execution,
  type ScheduledTask,
} from './schedule-model';
import './schedule-detail.css';

export type ScheduleDetailTab = 'details' | 'history';
const tabs: { id: ScheduleDetailTab; label: string }[] = [
  { id: 'details', label: '任务详情' },
  { id: 'history', label: '执行历史' },
];

interface DrawerProps {
  task: ScheduledTask;
  tab: ScheduleDetailTab;
  onTabChange: (tab: ScheduleDetailTab) => void;
  onClose: () => void;
  onEdit: () => void;
  onAction: (kind: 'toggle' | 'run' | 'delete') => void;
  pending: boolean;
  error?: string;
  onOpenConversation: (id: string) => Promise<void>;
}

function RunHistory({
  task,
  onOpenConversation,
}: Pick<DrawerProps, 'task' | 'onOpenConversation'>) {
  const [items, setItems] = useState<Execution[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null | undefined>();
  const [opening, setOpening] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const regionId = useId();

  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ items: Execution[] }>(
          `/schedules/${encodeURIComponent(task.id)}/runs`,
        );
        if (active) {
          setItems(result.items);
          setLoadError('');
        }
      } catch (cause) {
        if (active) setLoadError(errorText(cause));
      } finally {
        loading = false;
      }
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) void load();
    };
    void load();
    const timer = window.setInterval(refreshWhenVisible, 5000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [task.id, task.lastRun?.id, task.lastRun?.status, retry]);

  const openConversation = async (run: Execution) => {
    if (!run.taskId || opening) return;
    setOpening(run.id);
    setConversationError(null);
    try {
      await onOpenConversation(run.taskId);
    } catch (cause) {
      setConversationError({ id: run.id, message: errorText(cause) });
    } finally {
      setOpening(null);
    }
  };

  return (
    <section
      aria-label={`${task.name}的运行记录`}
      className="schedule-run-list"
    >
      <div className="schedule-drawer-section-title">
        <h3>运行记录</h3>
        <small>最近 100 次 · 北京时间</small>
      </div>
      {loadError && (
        <div className="schedule-error" role="alert">
          {loadError}
          <Button
            variant="ghost"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      )}
      {items === null && !loadError && (
        <p className="schedule-drawer-status" role="status">
          正在加载运行记录…
        </p>
      )}
      {items?.length === 0 && !loadError && (
        <p className="schedule-drawer-empty">
          <Icon name="clock" size={20} />
          暂无运行记录
        </p>
      )}
      {items && items.length > 0 && (
        <ol>
          {items.map((run, index) => {
            const expanded =
              expandedId === undefined ? index === 0 : expandedId === run.id;
            const contentId = regionId + '-' + run.id;
            const summaryIsError =
              run.error && run.summary?.startsWith(run.error);
            return (
              <li key={run.id}>
                <button
                  type="button"
                  className="schedule-run-heading"
                  aria-expanded={expanded}
                  aria-controls={contentId}
                  onClick={() => setExpandedId(expanded ? null : run.id)}
                >
                  <time dateTime={run.startedAt}>
                    {timestamp(run.startedAt, true)}
                  </time>
                  <span>
                    {run.trigger === 'manual' ? '手动运行' : '定时执行'}
                  </span>
                  <RunBadge status={run.status} />
                  <Icon name={expanded ? 'down' : 'chevron'} size={15} />
                </button>
                <div
                  id={contentId}
                  hidden={!expanded}
                  className="schedule-run-body"
                >
                  {expanded && (
                    <>
                      <div className="schedule-run-times">
                        {run.scheduledAt && (
                          <span>
                            计划于{' '}
                            <time dateTime={run.scheduledAt}>
                              {timestamp(run.scheduledAt, true)}
                            </time>
                          </span>
                        )}
                        {run.finishedAt && (
                          <span>
                            结束于{' '}
                            <time dateTime={run.finishedAt}>
                              {timestamp(run.finishedAt, true)}
                            </time>
                          </span>
                        )}
                      </div>
                      {run.name && run.name !== task.name && (
                        <p className="schedule-run-snapshot">
                          执行时名称：{run.name}
                        </p>
                      )}
                      {run.prompt && run.prompt !== task.prompt && (
                        <details className="schedule-run-snapshot">
                          <summary>执行时的任务内容</summary>
                          <p>{run.prompt}</p>
                        </details>
                      )}
                      {run.error && (
                        <p className="schedule-run-problem">
                          {summaryIsError ? run.summary : run.error}
                        </p>
                      )}
                      {run.summary && !summaryIsError && (
                        <MessageText
                          text={run.summary}
                          tableLabel="本次运行结果中的表格"
                          className="schedule-run-result"
                        />
                      )}
                      {run.status === 'running' && (
                        <p className="schedule-drawer-status">
                          正在执行，结果将自动更新。
                        </p>
                      )}
                      {run.taskId && (
                        <Button
                          variant="ghost"
                          disabled={opening !== null}
                          onClick={() => void openConversation(run)}
                        >
                          {opening === run.id
                            ? '正在打开…'
                            : run.status === 'awaiting_input'
                              ? '查看会话并处理'
                              : '查看会话'}
                          <Icon name="arrow" size={14} />
                        </Button>
                      )}
                      {conversationError?.id === run.id && (
                        <p className="schedule-run-problem" role="alert">
                          {conversationError.message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ScheduleOverview({ task }: { task: ScheduledTask }) {
  return (
    <>
      <section>
        <h3>执行计划</h3>
        <dl className="schedule-detail-fields">
          <div>
            <dt>运行时间</dt>
            <dd>{planLabel(task)}</dd>
          </div>
          <div>
            <dt>时区</dt>
            <dd>北京时间（UTC+8）</dd>
          </div>
          <div>
            <dt>下次执行</dt>
            <dd>
              {task.nextRunAt ? (
                <time dateTime={task.nextRunAt}>
                  {timestamp(task.nextRunAt, true)}
                </time>
              ) : (
                '暂无安排'
              )}
            </dd>
          </div>
        </dl>
      </section>
      <section>
        <h3>执行内容</h3>
        <p className="schedule-detail-prompt">
          {task.prompt || '暂无执行内容'}
        </p>
      </section>
      {(task.createdAt || task.updatedAt) && (
        <section className="schedule-detail-dates">
          <dl className="schedule-detail-fields">
            {task.createdAt && (
              <div>
                <dt>创建时间</dt>
                <dd>
                  <time dateTime={task.createdAt}>
                    {timestamp(task.createdAt, true)}
                  </time>
                </dd>
              </div>
            )}
            {task.updatedAt && (
              <div>
                <dt>更新时间</dt>
                <dd>
                  <time dateTime={task.updatedAt}>
                    {timestamp(task.updatedAt, true)}
                  </time>
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </>
  );
}

export function ScheduleDetailDrawer({
  task,
  tab,
  onTabChange,
  onClose,
  onEdit,
  onAction,
  pending,
  error,
  onOpenConversation,
}: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    title.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
    };
  }, []);
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <dialog
      ref={ref}
      className="detail-dialog schedule-detail-drawer"
      aria-labelledby={id + '-title'}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== ref.current) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <header className="schedule-detail-heading">
        <div>
          <h2 ref={title} tabIndex={-1} id={id + '-title'}>
            {task.name}
          </h2>
          <div className="schedule-detail-meta">
            <span>
              {task.kind === 'audit' ? '整理我的工作' : '自定义 Agent 任务'}
            </span>
            <Badge tone={task.enabled ? 'green' : 'neutral'}>
              {scheduleStateLabel(task)}
            </Badge>
            {task.running && <RunBadge status="running" />}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭任务详情"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div
        role="tablist"
        aria-label="自动化任务详情"
        className="schedule-detail-tabs"
      >
        {tabs.map((t) => (
          <button
            type="button"
            id={id + '-' + t.id}
            key={t.id}
            role="tab"
            aria-controls={id + '-panel-' + t.id}
            aria-selected={t.id === tab}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => onTabChange(t.id)}
            onKeyDown={(event) => {
              let next: ScheduleDetailTab;
              if (event.key === 'Home') next = 'details';
              else if (event.key === 'End') next = 'history';
              else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
                next = t.id === 'details' ? 'history' : 'details';
              else return;
              event.preventDefault();
              onTabChange(next);
              document.getElementById(id + '-' + next)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="schedule-detail-scroll" ref={body}>
        <div
          role="tabpanel"
          tabIndex={0}
          id={id + '-panel-details'}
          aria-labelledby={id + '-details'}
          hidden={tab !== 'details'}
        >
          {tab === 'details' && <ScheduleOverview task={task} />}
        </div>
        <div
          role="tabpanel"
          tabIndex={0}
          id={id + '-panel-history'}
          aria-labelledby={id + '-history'}
          hidden={tab !== 'history'}
        >
          {tab === 'history' && (
            <RunHistory
              key={task.id}
              task={task}
              onOpenConversation={onOpenConversation}
            />
          )}
        </div>
      </div>
      {error && (
        <p className="schedule-detail-error" role="alert">
          {error}
        </p>
      )}
      <footer className="schedule-detail-actions">
        <button
          type="button"
          className="icon-btn"
          title="删除任务"
          aria-label="删除任务"
          disabled={pending || task.running}
          onClick={() => onAction('delete')}
        >
          <Icon name="trash" size={17} />
        </button>
        <Button disabled={pending} onClick={() => onAction('toggle')}>
          {task.enabled ? '暂停' : '启用'}
        </Button>
        <Button disabled={pending} icon="edit" onClick={onEdit}>
          编辑任务
        </Button>
        <Button
          variant="primary"
          disabled={pending || task.running}
          onClick={() => onAction('run')}
        >
          {task.running ? '执行中' : '立即运行'}
        </Button>
      </footer>
    </dialog>
  );
}
