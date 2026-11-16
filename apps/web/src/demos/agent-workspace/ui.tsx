import type { ReactNode, ButtonHTMLAttributes } from 'react';
export function Icon({
  name = 'spark',
  size = 18,
  ...props
}: {
  name?: string;
  size?: number;
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    spark: (
      <>
        <path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3Z" />
        <path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" />
      </>
    ),
    chat: (
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
    ),
    home: (
      <>
        <path d="m3 10 9-7 9 7v10H3Z" />
        <path d="M9 20v-7h6v7" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H5v18h14V8Z" />
        <path d="M14 3v6h5M8 13h8M8 17h5" />
      </>
    ),
    tasks: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 2v4m8-4v4M7 11h10M7 16h6" />
      </>
    ),
    chart: (
      <>
        <path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4" />
      </>
    ),
    shield: (
      <>
        <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    book: (
      <>
        <path d="M12 5s-4-3-9-1v15c5-2 9 1 9 1s4-3 9-1V4c-5-2-9 1-9 1Z" />
        <path d="M12 5v15" />
      </>
    ),
    folder: <path d="M3 7V4h6l3 3h9v13H3Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    up: <path d="M12 19V5m-6 6 6-6 6 6" />,
    down: <path d="m6 9 6 6 6-6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    back: <path d="m14 5-7 7 7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m4 12 5 5L20 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    bell: (
      <>
        <path d="M6 8a6 6 0 0 1 12 0v7l2 3H4l2-3ZM10 21h4" />
      </>
    ),
    link: (
      <>
        <path d="m10 14 4-4m-5 7-2 2a4.2 4.2 0 0 1-6-6l4-4a4.2 4.2 0 0 1 6 0m2-2 2-2a4.2 4.2 0 0 1 6 6l-4 4a4.2 4.2 0 0 1-6 0" />
      </>
    ),
    attach: (
      <path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7L13 2m3 7-7 7" />
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4" />
      </>
    ),
    edit: (
      <>
        <path d="m15 3 6 6-12 12H3v-6ZM12 6l6 6" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 8a2.5 2.5 0 1 1 3 4v2M12 17h.01" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
      </>
    ),
    alert: (
      <>
        <path d="m12 3 10 18H2Z" />
        <path d="M12 9v5m0 3h.01" />
      </>
    ),
    layout: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
      </>
    ),
    brief: (
      <>
        <path d="M4 4h16v16H4ZM4 10h16M10 10v10" />
      </>
    ),
    plane: <path d="m3 11 7 1 6-8 3-1-1 4-5 7 4 5-1 2-6-4-5 3-2-1 3-5Z" />,
    wallet: (
      <>
        <path d="M3 7V4h15v3M3 7h18v14H3Z" />
        <path d="M15 11h6v6h-6Z" />
      </>
    ),
    star: <path d="m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="2" />
        <path d="M16 8V3H3v13h5" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3" />
      </>
    ),
    trash: (
      <>
        <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] ?? paths.spark}
    </svg>
  );
}
export function Button({
  children,
  variant = 'secondary',
  icon,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: string;
}) {
  return (
    <button className={`btn ${variant}`} type="button" {...props}>
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name="search" size={28} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
export function Field({
  label,
  children,
  error,
}: {
  label: string;
  children: ReactNode;
  error?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}
export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="business-section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}
export function Money({ value }: { value: number }) {
  return (
    <span className="money">
      ¥
      {(value / 100).toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}
    </span>
  );
}
