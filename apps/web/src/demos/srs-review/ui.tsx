import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';

const paths: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  chevron: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6',
  check: 'M5 12l4 4L19 6',
  file: 'M14 2H5v20h14V7zM14 2v6h5M8 12h8M8 16h6',
  arrow: 'M5 12h14M14 7l5 5-5 5',
  clock: 'M12 7v6l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6',
  edit: 'M15 4l5 5M4 20l5-1L21 7l-5-5L4 14z',
  chat: 'M21 11a9 8 0 0 1-9 8H7l-4 3v-7a8 8 0 0 1 0-8 9 8 0 0 1 18 4zM7 10h10M7 14h6',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  send: 'M12 19V5M5 12l7-7 7 7',
  refresh: 'M20 8a8 8 0 1 0 0 8M20 3v6h-6',
  back: 'M19 12H5M10 7l-5 5 5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  out: 'M14 3h7v7M21 3L10 14M10 3H3v18h18v-7',
  spark: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  alert: 'M12 3L2 21h20zM12 9v5m0 3v.1',
  calendar: 'M4 5h16v16H4zM8 2v6m8-6v6M4 10h16',
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.file} />
    </svg>
  );
}
export function Button({
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`srs-btn ${className}`} />;
}
export function Drawer({
  title,
  eyebrow,
  onClose,
  children,
  footer,
  width = 580,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key !== 'Tab') return;
      const list = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length);
      const first = list[0],
        last = list[list.length - 1];
      if (!first) {
        e.preventDefault();
        return;
      }
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !panel.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="srs-drawer-layer">
      <div className="srs-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="srs-drawer"
        style={{ width }}
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="srs-drawer-head">
          <div>
            {eyebrow && <p>{eyebrow}</p>}
            <h2>{title}</h2>
          </div>
          <Button
            className="icon-only subtle"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <Icon name="close" />
          </Button>
        </header>
        <div className="srs-drawer-body">{children}</div>
        {footer && <footer className="srs-drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
