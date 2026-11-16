import { describe, expect, it } from 'vitest';
import {
  BusinessDateSchema,
  NonNegativeMoneySchema,
  yuanToMoney,
} from '@caixiaozhi/contracts/finance-common';
import { calculateTravelBudget } from '../../apps/api/src/modules/business/calculations.js';

describe('业务金额与日期边界', () => {
  it.each(['2026-02-29', '2026-04-31', '2026/11/05', '2026-13-01'])(
    '拒绝无效业务日期 %s',
    (value) => {
      expect(BusinessDateSchema.safeParse(value).success).toBe(false);
    },
  );
  it('允许闰年和明确的零预算', () => {
    expect(BusinessDateSchema.parse('2028-02-29')).toBe('2028-02-29');
    expect(
      NonNegativeMoneySchema.parse({ amount_minor: '0', currency: 'CNY' }),
    ).toEqual({ amount_minor: '0', currency: 'CNY' });
  });
  it('人民币元通过字符串精确转换成分', () => {
    expect(yuanToMoney('1000.01').amount_minor).toBe('100001');
    expect(() => yuanToMoney('12.345')).toThrow();
    expect(() => yuanToMoney('1e3')).toThrow();
    expect(() => yuanToMoney('-1')).toThrow();
  });
  it('交通、住宿与其他预算使用整数分计算', () => {
    expect(
      calculateTravelBudget([
        {
          transport_budget: { amount_minor: '12000', currency: 'CNY' },
          lodging_required: true,
          check_in: '2026-11-10',
          check_out: '2026-11-12',
          room_count: '2',
          nightly_room_budget: { amount_minor: '80000', currency: 'CNY' },
          other_budget: { amount_minor: '300', currency: 'CNY' },
        },
      ]),
    ).toEqual({ amount_minor: '332300', currency: 'CNY' });
  });
});
