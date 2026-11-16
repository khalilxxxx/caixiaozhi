import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiFailure, labels } from './api.js';
export function Status({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`status status-${value}`}>
      {label ?? labels[value] ?? value}
    </span>
  );
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : '操作失败，请重试。';
  return (
    <div className="error-notice" role="alert">
      <strong>{message}</strong>
      {error instanceof ApiFailure && error.code === 'VERSION_CONFLICT' && (
        <p>保留当前输入，刷新最新版本后重新比较并保存。</p>
      )}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const labelId = useId();
  const hintId = `${labelId}-hint`;
  type FieldChildProps = {
    children?: ReactNode;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
  };
  const labelControl = (child: ReactNode): ReactNode => {
    if (!isValidElement<FieldChildProps>(child)) return child;
    if (
      ['input', 'select', 'textarea'].includes(String(child.type)) ||
      typeof child.type === 'function'
    ) {
      return cloneElement(child, {
        'aria-labelledby': labelId,
        'aria-describedby':
          [child.props['aria-describedby'], hint ? hintId : undefined]
            .filter(Boolean)
            .join(' ') || undefined,
      });
    }
    return child.props.children
      ? cloneElement(child, {
          children: Children.map(child.props.children, labelControl),
        })
      : child;
  };
  return (
    <label className="form-field">
      <span id={labelId}>{label}</span>
      {Children.map(children, labelControl)}
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
const drawerStack: HTMLElement[] = [];
let bodyOverflow = '';
const syncDrawers = () =>
  drawerStack.forEach((element, index) => {
    element.inert = index !== drawerStack.length - 1;
  });
export function Drawer({
  title,
  subtitle,
  children,
  onClose,
  dirty = false,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  dirty?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const latest = useRef({ onClose, dirty });
  latest.current = { onClose, dirty };
  const close = () => (dirty ? setConfirmClose(true) : onClose());
  useEffect(() => {
    const element = ref.current!;
    if (drawerStack.length === 0) {
      bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    drawerStack.push(element);
    syncDrawers();
    restore.current = document.activeElement as HTMLElement;
    ref.current
      ?.querySelector<HTMLElement>(
        'button,input,select,textarea,[tabindex="0"]',
      )
      ?.focus();
    const handle = (event: KeyboardEvent) => {
      if (drawerStack.at(-1) !== element) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (latest.current.dirty) setConfirmClose(true);
        else latest.current.onClose();
      }
      if (event.key === 'Tab' && ref.current) {
        const controls = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
          ),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('keydown', handle);
      const index = drawerStack.indexOf(element);
      if (index >= 0) drawerStack.splice(index, 1);
      syncDrawers();
      if (drawerStack.length === 0) document.body.style.overflow = bodyOverflow;
      if (restore.current?.isConnected) restore.current.focus();
    };
  }, []);
  return (
    <>
      <div className="drawer-scrim" onClick={close} />
      <aside
        ref={ref}
        className={`drawer ${wide ? 'drawer-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="drawer-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            className="icon-button"
            aria-label="关闭详情"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="m5 5 10 10M15 5 5 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </header>
        {confirmClose && (
          <div className="unsaved-notice" role="alert">
            <p>当前有未保存修改。</p>
            <button type="button" onClick={() => setConfirmClose(false)}>
              继续编辑
            </button>
            <button type="button" className="danger-button" onClick={onClose}>
              放弃修改并关闭
            </button>
          </div>
        )}
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
export function SectionTitle({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-title">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="button-row">{actions}</div>}
    </header>
  );
}
