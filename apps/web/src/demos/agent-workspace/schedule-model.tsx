import { Badge } from './ui';

export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'once';
export interface ScheduleForm {
  name: string;
  kind: 'audit' | 'agent';
  prompt: string;
  frequency: Frequency;
  time: string;
  weekdays: number[];
  date: string;
  enabled: boolean;
}
export interface Execution {
  id: string;
  status: string;
  trigger: string;
  scheduledAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  error: string;
  taskId: string | null;
  name?: string;
  prompt?: string;
}
export interface ScheduledTask extends ScheduleForm {
  id: string;
  version: number;
  nextRunAt: string | null;
  lastRun?: Execution | null;
  running?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const weekdays = [
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
];
const statuses: Record<string, [string, string]> = {
  running: ['执行中', 'blue'],
  completed: ['已完成', 'green'],
  failed: ['失败', 'red'],
  awaiting_input: ['待确认', 'amber'],
  missed: ['已错过', 'amber'],
  skipped: ['已跳过', 'neutral'],
  interrupted: ['已中断', 'amber'],
  cancelled: ['已停止', 'neutral'],
};

const timeFormat = {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
} as const;
const briefTime = new Intl.DateTimeFormat('zh-CN', timeFormat);
const fullTime = new Intl.DateTimeFormat('zh-CN', {
  ...timeFormat,
  year: 'numeric',
});
export function timestamp(value?: string | null, includeYear = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return (includeYear ? fullTime : briefTime).format(date);
}
export function planLabel(item: ScheduleForm) {
  const prefix =
    item.frequency === 'daily'
      ? '每天'
      : item.frequency === 'weekdays'
        ? '周一至周五'
        : item.frequency === 'weekly'
          ? item.weekdays.map((day) => weekdays[day - 1]).join('、')
          : item.date;
  return `${prefix} ${item.time}`;
}
export function scheduleStateLabel(item: ScheduledTask) {
  if (item.enabled) return '已启用';
  return item.frequency === 'once' && item.lastRun?.trigger === 'scheduled'
    ? '已结束'
    : '已暂停';
}
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}
export function RunBadge({ status }: { status: string }) {
  const [label, tone] = statuses[status] ?? ['状态未知', 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}
