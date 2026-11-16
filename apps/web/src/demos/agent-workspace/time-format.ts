/** Preserve existing business labels; render backend timestamps in the user's timezone. */
export function businessTime(value?: string | null): string {
  if (!value) return '—';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return value;
  return time.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
