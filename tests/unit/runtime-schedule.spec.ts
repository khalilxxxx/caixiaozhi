import { describe, expect, it } from 'vitest';
import { nextOccurrence } from '../../packages/assistant/src/schedule.js';
describe('日程时区与DST', () => {
  it('工作日固定周一到周五，周六不生成，上海09:00正确转换UTC', () => {
    const result = nextOccurrence(
      {
        frequency: 'weekdays',
        local_time: '09:00',
        timezone: 'Asia/Shanghai',
        start_date: '2026-11-01',
      },
      new Date('2026-11-06T01:00:00Z'),
    );
    expect(result.at.toISOString()).toBe('2026-11-09T01:00:00.000Z');
  });
  it('DST重复选择第一次UTC发生，不存在时间顺延第一个有效时刻', () => {
    const repeated = nextOccurrence(
      {
        frequency: 'daily',
        local_time: '01:30',
        timezone: 'America/New_York',
        start_date: '2026-11-01',
      },
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(repeated.at.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    const gap = nextOccurrence(
      {
        frequency: 'daily',
        local_time: '02:30',
        timezone: 'America/New_York',
        start_date: '2026-03-08',
      },
      new Date('2026-03-08T00:00:00Z'),
    );
    expect(gap.at.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(gap.dst_adjusted).toBe(true);
  });
});
