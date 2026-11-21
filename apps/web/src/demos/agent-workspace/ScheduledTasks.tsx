import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './runtime-client';
import { useWorkspace } from './workspace';
import { Badge, Button, Empty, Field, Icon } from './ui';
import {
  errorText, planLabel, RunBadge, scheduleStateLabel, timestamp, weekdays,
  type Execution, type Frequency, type ScheduledTask, type ScheduleForm,
} from './schedule-model';
import { ScheduleDetailDrawer, type ScheduleDetailTab } from './ScheduleDetailDrawer';
import './schedules.css';

function ScheduleEditor({ item, onClose, onSaved }: {
  item: ScheduledTask | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const initial = useRef<ScheduleForm>(item ? {
    name: item.name, kind: item.kind, prompt: item.prompt, frequency: item.frequency,
    time: item.time, weekdays: item.weekdays, date: item.date, enabled: item.enabled,
  } : { name: '', kind: 'audit', prompt: '', frequency: 'daily', time: '09:00', weekdays: [1],
    date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), enabled: true });
  const [form, setForm] = useState(initial.current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = JSON.stringify(form) !== JSON.stringify(initial.current);
  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm(previous => ({ ...previous, [key]: value }));
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { if (trigger?.isConnected) trigger.focus(); };
  }, []);
  useEffect(() => {
    if (!changed) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [changed]);
  const close = () => {
    if (!saving && (!changed || window.confirm('有未保存的修改，确定放弃吗？'))) onClose();
  };
  return <dialog className="schedule-editor" ref={ref} aria-labelledby="schedule-editor-title" onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (saving) return;
      if (form.frequency === 'weekly' && !form.weekdays.length) { setError('请至少选择一个执行日。'); return; }
      setSaving(true); setError('');
      try {
        await api(item ? `/schedules/${item.id}` : '/schedules', { ...form, ...(item ? { version: item.version } : {}) }, item ? 'PATCH' : 'POST');
        onSaved();
      } catch (cause) { setError(errorText(cause)); }
      finally { setSaving(false); }
    }}>
      <header><h2 id="schedule-editor-title">{item ? '编辑定时任务' : '新建定时任务'}</h2><button type="button" className="icon-btn" aria-label="关闭" disabled={saving} onClick={close}><Icon name="close" /></button></header>
      <div className="schedule-form-body">
        <Field label="任务名称"><input autoFocus required maxLength={60} value={form.name} placeholder="例如：每天整理我的工作" onChange={e => set('name', e.target.value)} /></Field>
        <Field label="任务类型"><select value={form.kind} onChange={e => set('kind', e.target.value as ScheduleForm['kind'])}><option value="audit">整理我的工作</option><option value="agent">自定义 Agent 任务</option></select></Field>
        {form.kind === 'agent' ? <Field label="执行内容"><textarea required maxLength={4000} rows={4} value={form.prompt} placeholder="例如：查询待我处理的差旅申请，汇总超标事项和需要补充的材料" onChange={e => set('prompt', e.target.value)} /></Field> : <div className="schedule-action-summary"><Icon name="tasks" size={18} /><span>预审待本人审核的单据，汇总需关注和待核实事项。</span></div>}
        <div className="schedule-form-grid">
          <Field label="执行频率"><select value={form.frequency} onChange={e => set('frequency', e.target.value as Frequency)}><option value="daily">每天</option><option value="weekdays">工作日（周一至周五）</option><option value="weekly">每周</option><option value="once">仅一次</option></select></Field>
          <Field label="执行时间 · 北京时间"><input type="time" required value={form.time} onChange={e => set('time', e.target.value)} /></Field>
        </div>
        {form.frequency === 'weekly' && <fieldset className="schedule-weekdays"><legend>执行日</legend>{weekdays.map((day, index) => <label key={day}><input type="checkbox" checked={form.weekdays.includes(index + 1)} onChange={e => set('weekdays', e.target.checked ? [...form.weekdays, index + 1].sort() : form.weekdays.filter(value => value !== index + 1))} /><span>{day}</span></label>)}</fieldset>}
        {form.frequency === 'once' && <Field label="执行日期 · 北京时间"><input type="date" required value={form.date} onChange={e => set('date', e.target.value)} /></Field>}
        <label className="schedule-enabled"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />启用此任务</label>
        <p className="schedule-form-note">超过计划时间 15 分钟的任务将跳过本次执行。</p>
        {error && <p className="schedule-error" role="alert">{error}</p>}
      </div>
      <footer><Button disabled={saving} onClick={close}>取消</Button><Button type="submit" variant="primary" disabled={saving}>{saving ? '保存中…' : '保存任务'}</Button></footer>
    </form>
  </dialog>;
}

const scopes = [
  { id: 'all', label: '全部任务' },
  { id: 'enabled', label: '已启用' },
  { id: 'paused', label: '未启用' },
] as const;

type TaskAction = 'toggle' | 'run' | 'delete';
type DetailSelection = { id: string; tab: ScheduleDetailTab };

export function ScheduledTasksPage({
  onOpenConversation,
}: {
  onOpenConversation: (id: string) => Promise<void>;
}) {
  const w = useWorkspace();
  const [items, setItems] = useState<ScheduledTask[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof scopes)[number]['id']>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ item: ScheduledTask | null } | null>(
    null,
  );
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  const generation = useRef(0);
  const pageRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await api<{ items: ScheduledTask[] }>('/schedules');
      if (generation.current === request) {
        setItems(result.items);
        setError('');
      }
    } catch (cause) {
      if (generation.current === request) setError(errorText(cause));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [load]);

  const openDetail = (
    item: ScheduledTask,
    tab: ScheduleDetailTab,
    trigger?: HTMLButtonElement,
  ) => {
    if (trigger) opener.current = trigger;
    setActionError(null);
    setDetail({ id: item.id, tab });
  };
  const closeDetail = useCallback(() => {
    const trigger = opener.current;
    opener.current = null;
    setDetail(null);
    requestAnimationFrame(() => {
      const origin = trigger?.isConnected ? trigger : null;
      const target =
        (origin?.disabled ? null : origin) ??
        origin?.closest('tr')?.querySelector<HTMLButtonElement>('.schedule-open') ??
        pageRef.current?.querySelector<HTMLButtonElement>('.schedule-open') ??
        pageRef.current?.querySelector<HTMLInputElement>('.schedule-search input');
      target?.focus({ preventScroll: true });
    });
  }, []);
  const selected = detail && items.find((item) => item.id === detail.id);
  useEffect(() => {
    if (detail && !selected) closeDetail();
  }, [detail, selected, closeDetail]);

  const action = async (
    item: ScheduledTask,
    kind: TaskAction,
    trigger?: HTMLButtonElement,
  ) => {
    if (pending) return;
    if (
      kind === 'delete' &&
      !window.confirm(
        `删除“${item.name}”？后续计划将停止，已生成的会话仍保留。`,
      )
    )
      return;
    setPending(item.id);
    setActionError(null);
    if (kind === 'run') openDetail(item, 'history', trigger);
    const path = `/schedules/${encodeURIComponent(item.id)}`;
    try {
      if (kind === 'toggle') {
        const result = await api<{ item: ScheduledTask }>(
          path,
          { version: item.version, enabled: !item.enabled },
          'PATCH',
        );
        setItems((previous) =>
          previous.map((t) =>
            t.id === item.id ? { ...t, ...result.item } : t,
          ),
        );
      } else if (kind === 'delete') {
        await api(`${path}?version=${item.version}`, undefined, 'DELETE');
        setItems((previous) => previous.filter((t) => t.id !== item.id));
      } else {
        const { run } = await api<{ run: Execution }>(path + '/run', {});
        setItems((previous) =>
          previous.map((t) =>
            t.id === item.id
              ? { ...t, lastRun: run, running: run.status === 'running' }
              : t,
          ),
        );
      }
      await load();
      w.notify(
        kind === 'delete'
          ? '定时任务已删除'
          : kind === 'run'
            ? '已开始执行'
            : item.enabled
              ? '已暂停后续执行'
              : '定时任务已启用',
      );
    } catch (cause) {
      setActionError({ id: item.id, message: errorText(cause) });
      void load();
    } finally {
      setPending(null);
    }
  };
  const search = query.trim().toLocaleLowerCase();
  const matches = items.filter(
    (item) =>
      `${item.name} ${item.prompt}`.toLocaleLowerCase().includes(search) &&
      (filter === 'all' || item.enabled === (filter === 'enabled')),
  );
  return (
    <div className="schedules-page" ref={pageRef}>
      <div className="schedule-toolbar">
        <div className="schedule-scopes" role="group" aria-label="任务状态">
          {scopes.map((scope) => (
            <button
              key={scope.id}
              type="button"
              aria-pressed={filter === scope.id}
              onClick={() => setFilter(scope.id)}
            >
              {scope.label}
            </button>
          ))}
        </div>
        <div className="schedule-toolbar-actions">
          <label className="schedule-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              aria-label="搜索定时任务"
              placeholder="搜索任务名称或内容"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="icon-btn schedule-refresh"
            aria-label="刷新任务列表"
            title="刷新任务列表"
            disabled={loading}
            onClick={() => void load()}
          >
            <Icon name="refresh" size={16} />
          </button>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setEditor({ item: null })}
          >
            新建任务
          </Button>
        </div>
      </div>
      {error && (
        <div className="schedule-error" role="alert">
          {error}
          <Button variant="ghost" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      {actionError && actionError.id !== selected?.id && (
        <p role="alert" className="schedule-error">
          {actionError.message}
        </p>
      )}
      {loading ? (
        <div className="schedule-loading" role="status">
          正在加载定时任务…
        </div>
      ) : !matches.length ? (
        !error && (
          <Empty title={items.length ? '没有符合条件的任务' : '暂无定时任务'}>
            {items.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                清除筛选
              </Button>
            )}
          </Empty>
        )
      ) : (
        <div className="schedule-table-wrap">
          <table className="schedule-table" aria-label="定时任务">
            <thead>
              <tr>
                <th scope="col">任务</th>
                <th scope="col">执行计划</th>
                <th scope="col">下次执行</th>
                <th scope="col">最近运行</th>
                <th scope="col">
                  <span className="schedule-sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {matches.map((item) => (
                <ScheduleRow
                  key={item.id}
                  item={item}
                  disabled={pending !== null}
                  onOpen={(tab, trigger) => openDetail(item, tab, trigger)}
                  onRun={(trigger) => void action(item, 'run', trigger)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && (!error || items.length > 0) && (
        <div className="schedule-footer">
          <span>
            {items.length} 个任务 ·{' '}
            {items.filter((item) => item.enabled).length} 个已启用
          </span>
          <span>北京时间 UTC+8</span>
        </div>
      )}
      {detail && selected && (
        <ScheduleDetailDrawer
          key={selected.id}
          task={selected}
          tab={detail.tab}
          onTabChange={(tab) => setDetail({ id: selected.id, tab })}
          onClose={closeDetail}
          onEdit={() => setEditor({ item: selected })}
          onAction={(kind) => void action(selected, kind)}
          pending={pending !== null}
          error={
            actionError?.id === selected.id ? actionError.message : undefined
          }
          onOpenConversation={onOpenConversation}
        />
      )}
      {editor && (
        <ScheduleEditor
          item={editor.item}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
            w.notify('定时任务已保存');
          }}
        />
      )}
    </div>
  );
}

function ScheduleRow({
  item,
  disabled,
  onOpen,
  onRun,
}: {
  item: ScheduledTask;
  disabled: boolean;
  onOpen: (tab: ScheduleDetailTab, trigger: HTMLButtonElement) => void;
  onRun: (trigger: HTMLButtonElement) => void;
}) {
  const name = useRef<HTMLButtonElement>(null);
  return (
    <tr
      className="schedule-item"
      onClick={(event) => {
        if ((event.target as Element).closest('button') || !name.current)
          return;
        name.current.focus({ preventScroll: true });
        onOpen('details', name.current);
      }}
    >
      <td>
        <div className="schedule-identity">
          <span className="schedule-symbol" aria-hidden="true">
            <Icon name={item.kind === 'audit' ? 'tasks' : 'spark'} size={21} />
          </span>
          <div className="schedule-labels">
            <button
              className="schedule-open"
              ref={name}
              type="button"
              aria-haspopup="dialog"
              onClick={(e) => onOpen('details', e.currentTarget)}
            >
              {item.name}
            </button>
            <div className="schedule-kind">
              <span>
                {item.kind === 'audit' ? '整理我的工作' : '自定义 Agent 任务'}
              </span>
              <Badge tone={item.enabled ? 'green' : 'neutral'}>
                {scheduleStateLabel(item)}
              </Badge>
            </div>
          </div>
        </div>
      </td>
      <td>
        <span className="schedule-mobile-label" aria-hidden="true">
          执行计划
        </span>
        {planLabel(item)}
      </td>
      <td>
        <span className="schedule-mobile-label" aria-hidden="true">
          下次执行
        </span>
        {item.nextRunAt ? (
          <time dateTime={item.nextRunAt}>{timestamp(item.nextRunAt)}</time>
        ) : (
          <span className="schedule-muted">暂无安排</span>
        )}
      </td>
      <td>
        <span className="schedule-mobile-label" aria-hidden="true">
          最近运行
        </span>
        <button
          type="button"
          className="schedule-recent"
          aria-haspopup="dialog"
          aria-label={`查看${item.name}的执行历史`}
          title="查看执行历史"
          onClick={(e) => onOpen('history', e.currentTarget)}
        >
          {item.lastRun ? (
            <>
              <RunBadge status={item.lastRun.status} />
              <time dateTime={item.lastRun.startedAt}>
                {timestamp(item.lastRun.startedAt)}
              </time>
            </>
          ) : (
            <span>暂无记录</span>
          )}
        </button>
      </td>
      <td>
        <div className="schedule-row-actions">
          <Button
            disabled={disabled || item.running}
            onClick={(e) => onRun(e.currentTarget)}
          >
            {item.running ? '执行中' : '立即运行'}
          </Button>
          <Icon name="chevron" size={16} />
        </div>
      </td>
    </tr>
  );
}
