import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from './runtime-client';
import { Icon } from './ui';
import { boardScopeFromHash } from './business-board-handoff';
import { BusinessBoardVisuals } from './BusinessBoardVisuals';
import {
  boardDateLabel,
  businessBoardQuery,
  type BusinessBoardOptions,
  type BusinessBoardScope,
  type BusinessBoardSnapshot,
} from './business-board-model';
import './business-board.css';

const basePath = '/analytics/business';
const scopeStorage = 'cxz.business-board.scope.v1';

function useBoardResource<T>(url: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data?: T;
    error?: string;
  }>({ key: '' });
  const key = url + '#' + attempt;
  useEffect(() => {
    let current = true;
    api<T>(url).then(
      (data) => {
        if (current) setResult({ key, data });
      },
      (error) => {
        if (current)
          setResult({
            key,
            error: error instanceof Error ? error.message : '读取看板失败。',
          });
      },
    );
    return () => {
      current = false;
    };
  }, [url, key]);
  return {
    ...(result.key === key ? result : {}),
    retry: () => setAttempt((n) => n + 1),
  };
}

function recentScope(options: BusinessBoardOptions): BusinessBoardScope {
  try {
    const saved: BusinessBoardScope | null = JSON.parse(
      sessionStorage.getItem(scopeStorage) || 'null',
    );
    if (
      saved &&
      options.systems.some((s) => s.id === saved.system) &&
      Array.isArray(saved.departmentIds) &&
      saved.departmentIds.length &&
      saved.departmentIds.every((id) =>
        options.departments.some((department) => department.id === id),
      ) &&
      /^\d{4}-\d{2}-\d{2}$/.test(saved.startDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(saved.endDate) &&
      saved.startDate <= saved.endDate
    )
      return saved;
  } catch {
    /* The server defaults also work without browser storage. */
  }
  return options.defaultScope;
}

function Header({
  onAsk,
  disabled,
  asking,
}: {
  onAsk?: () => void;
  disabled?: boolean;
  asking?: boolean;
}) {
  return (
    <header className="bb-header">
      <div className="bb-title">
        <img
          src="/agent-assets/xiaozhi-ready.png"
          width="82"
          height="82"
          alt=""
        />
        <h1>数据分析</h1>
      </div>
      <button
        type="button"
        className="bb-ask"
        onClick={onAsk}
        disabled={disabled || asking}
      >
        <Icon name="xiaozhi" size={20} />
        {asking ? '正在打开…' : '问小智'}
        <Icon name="arrow" size={15} />
      </button>
    </header>
  );
}

function Feedback({ error, retry }: { error?: string; retry: () => void }) {
  return (
    <div className="bb-feedback" role={error ? 'alert' : 'status'}>
      <Icon name={error ? 'error-circle' : 'chart'} size={24} />
      <span>{error || '正在读取看板数据…'}</span>
      {error && (
        <button type="button" className="bb-control" onClick={retry}>
          重新加载
        </button>
      )}
    </div>
  );
}

function FilterPopover({
  icon,
  label,
  description,
  children,
}: {
  icon: string;
  label: string;
  description: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLElement>('input, button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <div
      ref={wrapper}
      className="bb-pop-anchor"
      onBlur={(e) => {
        if (
          e.relatedTarget &&
          !e.currentTarget.contains(e.relatedTarget as Node)
        )
          setOpen(false);
      }}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="bb-control"
        aria-label={`${label}，${description}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name={icon} size={15} />
        <span>{description}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div
          ref={popup}
          role="dialog"
          aria-label={label}
          id={id}
          className="bb-pop"
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

function DateForm({
  scope,
  anchor,
  coverage,
  apply,
}: {
  scope: BusinessBoardScope;
  anchor: string;
  coverage: BusinessBoardOptions['coverage'];
  apply: (dates: Pick<BusinessBoardScope, 'startDate' | 'endDate'>) => void;
}) {
  const [start, setStart] = useState(scope.startDate);
  const [end, setEnd] = useState(scope.endDate);
  const [year, month] = anchor.split('-').map(Number);
  const presets = Array.from({ length: 3 }, (_, offset) => {
    const first = new Date(Date.UTC(year!, month! - 1 - offset, 1));
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    );
    return {
      label: first.getUTCMonth() + 1 + '月',
      startDate: first.toISOString().slice(0, 10),
      endDate: offset === 0 ? anchor : last.toISOString().slice(0, 10),
    };
  });
  const invalid = Boolean(start && end && start > end);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (start && end && !invalid) apply({ startDate: start, endDate: end });
      }}
    >
      <strong className="bb-pop-title">统计日期</strong>
      <div className="bb-presets">
        {presets.map((p) => (
          <button
            key={p.startDate}
            type="button"
            aria-pressed={start === p.startDate && end === p.endDate}
            onClick={() =>
              apply({ startDate: p.startDate, endDate: p.endDate })
            }
          >
            {p.label}
          </button>
        ))}
      </div>
      <label className="bb-date-field">
        <span>开始日期</span>
        <input
          type="date"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          required
        />
      </label>
      <label className="bb-date-field">
        <span>结束日期</span>
        <input
          type="date"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          required
          aria-invalid={invalid || undefined}
        />
      </label>
      {coverage && (
        <p className="bb-pop-coverage">台账覆盖 {boardDateLabel(coverage)}</p>
      )}
      {invalid && (
        <p className="bb-filter-error" role="alert">
          结束日期需等于或晚于开始日期。
        </p>
      )}
      <button
        className="bb-apply"
        type="submit"
        disabled={!start || !end || invalid}
      >
        应用日期
      </button>
    </form>
  );
}

function DepartmentForm({
  options,
  scope,
  apply,
}: {
  options: BusinessBoardOptions;
  scope: BusinessBoardScope;
  apply: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState(scope.departmentIds);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (selected.length)
          apply(
            options.departments
              .filter((item) => selected.includes(item.id))
              .map((item) => item.id),
          );
      }}
    >
      <strong className="bb-pop-title">部门范围</strong>
      {options.departments.map(({ id, name }) => (
        <label key={id} className="bb-dept-option">
          <input
            type="checkbox"
            checked={selected.includes(id)}
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...selected, id]
                  : selected.filter((item) => item !== id),
              )
            }
          />
          {name}
        </label>
      ))}
      <button className="bb-apply" type="submit" disabled={!selected.length}>
        应用部门
      </button>
    </form>
  );
}

interface BoardProps {
  initialScope?: BusinessBoardScope;
  onAsk: (snapshot: BusinessBoardSnapshot) => void | Promise<void>;
}

function Dashboard({
  options,
  initialScope,
  onAsk,
}: BoardProps & { options: BusinessBoardOptions }) {
  const [scope, setScope] = useState(
    () => initialScope ?? recentScope(options),
  );
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState('');
  const { data, error, retry } = useBoardResource<BusinessBoardSnapshot>(
    basePath + '/board?' + businessBoardQuery(scope),
  );
  const update = (next: BusinessBoardScope) => {
    setAskError('');
    setScope(next);
  };
  // Persist only scopes accepted by the service.
  useEffect(() => {
    if (data) {
      try {
        sessionStorage.setItem(scopeStorage, JSON.stringify(data.scope));
      } catch {
        /* Optional view preference. */
      }
    }
  }, [data]);
  const ask = async () => {
    if (!data || asking) return;
    setAsking(true);
    setAskError('');
    try {
      await onAsk(data);
    } catch (err) {
      setAskError(
        err instanceof Error ? err.message : '打开会话失败，请重试。',
      );
    } finally {
      setAsking(false);
    }
  };
  const names = options.departments
    .filter((d) => scope.departmentIds.includes(d.id))
    .map((d) => d.name);
  const department =
    names.length <= 1 ? (names[0] ?? '选择部门') : names.join('、');
  return (
    <>
      <Header onAsk={ask} disabled={!data} asking={asking} />
      {askError && (
        <p className="bb-filter-error" role="alert">
          {askError}
        </p>
      )}
      <div className="bb-toolbar">
        <div className="bb-systems" role="group" aria-label="业务系统">
          {options.systems.map((s) => (
            <button
              type="button"
              key={s.id}
              aria-pressed={scope.system === s.id}
              onClick={() => update({ ...scope, system: s.id })}
            >
              <Icon name={s.id === 'expense' ? 'wallet' : 'plane'} size={16} />
              {s.name}
            </button>
          ))}
        </div>
        <div className="bb-filterset">
          <FilterPopover
            icon="tasks"
            label="统计日期"
            description={boardDateLabel(scope)}
          >
            {(close) => (
              <DateForm
                scope={scope}
                anchor={options.defaultScope.endDate}
                coverage={options.coverage}
                apply={(dates) => {
                  update({ ...scope, ...dates });
                  close();
                }}
              />
            )}
          </FilterPopover>
          <FilterPopover icon="brief" label="部门范围" description={department}>
            {(close) => (
              <DepartmentForm
                scope={scope}
                options={options}
                apply={(departmentIds) => {
                  update({ ...scope, departmentIds });
                  close();
                }}
              />
            )}
          </FilterPopover>
        </div>
      </div>
      {data ? (
        <>
          <div className="bb-result-title">
            <h2>{data.title}</h2>
            <span>{data.source}</span>
          </div>
          <BusinessBoardVisuals snapshot={data} />
        </>
      ) : (
        <Feedback error={error} retry={retry} />
      )}
    </>
  );
}

export function BusinessBoardPage({ onAsk }: Pick<BoardProps, 'onAsk'>) {
  const [initialScope, setInitialScope] = useState(() =>
    boardScopeFromHash(location.hash),
  );
  useEffect(() => {
    const readLocation = () =>
      setInitialScope(boardScopeFromHash(location.hash));
    window.addEventListener('hashchange', readLocation);
    return () => window.removeEventListener('hashchange', readLocation);
  }, []);
  const { data, error, retry } = useBoardResource<BusinessBoardOptions>(
    basePath + '/options',
  );
  return (
    <div className="bb-page">
      {data ? (
        <Dashboard
          key={initialScope ? businessBoardQuery(initialScope) : 'current'}
          options={data}
          initialScope={initialScope}
          onAsk={onAsk}
        />
      ) : (
        <>
          <Header disabled />
          <Feedback error={error} retry={retry} />
        </>
      )}
    </div>
  );
}
