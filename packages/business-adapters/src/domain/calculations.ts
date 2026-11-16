import { NonNegativeMoneySchema } from '@caixiaozhi/contracts/finance-common';
import type { Money } from '@caixiaozhi/contracts/common';

type BudgetLeg = {
  transport_budget: Money | null;
  lodging_required: boolean;
  check_in: string | null;
  check_out: string | null;
  room_count: string | null;
  nightly_room_budget: Money | null;
  other_budget: Money;
};
export function businessDaysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
      86_400_000,
  );
}
export function calculateTravelBudget(legs: ReadonlyArray<BudgetLeg>) {
  let total = 0n;
  for (const leg of legs) {
    total +=
      BigInt(leg.transport_budget?.amount_minor ?? '0') +
      BigInt(leg.other_budget.amount_minor);
    if (
      leg.lodging_required &&
      leg.check_in &&
      leg.check_out &&
      leg.room_count &&
      leg.nightly_room_budget
    ) {
      total +=
        BigInt(businessDaysBetween(leg.check_in, leg.check_out)) *
        BigInt(leg.room_count) *
        BigInt(leg.nightly_room_budget.amount_minor);
    }
  }
  return NonNegativeMoneySchema.parse({
    amount_minor: total.toString(),
    currency: 'CNY',
  });
}
