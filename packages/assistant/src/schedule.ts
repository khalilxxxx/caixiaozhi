import type { DigestSchedule } from '@caixiaozhi/contracts/memory';
import { AppError } from '@caixiaozhi/platform/errors';

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(time: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return Object.fromEntries(
    formatter
      .formatToParts(time)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
}
export function localDateTime(time: Date, timezone: string) {
  const p = parts(time, timezone);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
}
function wallInstant(
  date: string,
  time: string,
  timezone: string,
): { at: Date; dst_adjusted: boolean } {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const instant = new Date(wall + h * 3600000);
    const p = parts(instant, timezone);
    offsets.add(
      Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) -
        Math.floor(instant.getTime() / 60000) * 60000,
    );
  }
  for (let shift = 0; shift <= 180; shift++) {
    const target = new Date(wall + shift * 60000);
    const targetDate = target.toISOString().slice(0, 10);
    const targetTime = target.toISOString().slice(11, 16);
    const candidates = [...offsets]
      .map((offset) => new Date(target.getTime() - offset))
      .filter((instant) => {
        const local = localDateTime(instant, timezone);
        return local.date === targetDate && local.time === targetTime;
      })
      .sort((a, b) => a.getTime() - b.getTime());
    if (candidates[0]) return { at: candidates[0], dst_adjusted: shift > 0 };
  }
  throw new AppError(
    'VALIDATION_ERROR',
    '该时区的计划时间无法计算，请调整时间。',
  );
}
export function nextOccurrence(schedule: DigestSchedule, after: Date) {
  const today = localDateTime(after, schedule.timezone).date;
  let date = today < schedule.start_date ? schedule.start_date : today;
  for (let i = 0; i < 400; i++) {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (schedule.frequency === 'daily' || (day !== 0 && day !== 6)) {
      const instant = wallInstant(date, schedule.local_time, schedule.timezone);
      if (instant.at > after)
        return {
          ...instant,
          local_date: date,
          local_time: schedule.local_time,
        };
    }
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  throw new AppError('VALIDATION_ERROR', '无法计算下一次计划时间。');
}
export function schedulePreview(
  schedule: DigestSchedule,
  after: Date,
  count = 3,
) {
  const result = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(schedule, cursor);
    result.push({
      scheduled_at: next.at.toISOString(),
      local_date: next.local_date,
      local_time: next.local_time,
      timezone: schedule.timezone,
      dst_adjusted: next.dst_adjusted,
    });
    cursor = next.at;
  }
  return result;
}
