import { z } from 'zod';
import { MoneySchema, VersionSchema } from './common.js';

export const BusinessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, '请填写有效的公历日期');
export const NonNegativeMoneySchema = MoneySchema.refine(
  (value) =>
    /^(0|[1-9][0-9]*)$/.test(value.amount_minor) &&
    BigInt(value.amount_minor) <= 100_000_000n,
  '金额必须是0至100000000整数分',
);
export const PositiveMoneySchema = NonNegativeMoneySchema.refine(
  (value) => BigInt(value.amount_minor) > 0n,
  '金额必须大于零',
);
export const MaterialRefSchema = z.strictObject({
  id: z.string().min(1),
  version: VersionSchema,
  purpose: z.string().max(200).optional(),
});
export function yuanToMoney(value: string) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(value))
    throw new Error('金额最多填写两位小数');
  const [whole = '0', fraction = ''] = value.split('.');
  return NonNegativeMoneySchema.parse({
    amount_minor: (
      BigInt(whole) * 100n +
      BigInt(fraction.padEnd(2, '0'))
    ).toString(),
    currency: 'CNY',
  });
}
export function moneySum(amounts: ReadonlyArray<{ amount_minor: string }>) {
  return NonNegativeMoneySchema.parse({
    amount_minor: amounts
      .reduce((sum, value) => sum + BigInt(value.amount_minor), 0n)
      .toString(),
    currency: 'CNY',
  });
}
