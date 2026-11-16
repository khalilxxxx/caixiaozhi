import { sql } from 'drizzle-orm';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import { ExpenseItemSchema } from '@caixiaozhi/contracts/expenses';
import { TravelLegSchema } from '@caixiaozhi/contracts/travel';
import { AppError } from '@caixiaozhi/platform/errors';
import { DocumentService } from './documents.js';
import { rawDocument, rows, type BusinessKind } from './store.js';

export type FieldIssue = { path: string; code: string; message: string };
export async function validateSubmission(
  service: DocumentService,
  actor: ActorContext,
  ref: ResourceRef,
  db: DatabaseExecutor = service.database.db,
) {
  const kind = ref.type as BusinessKind;
  const head = await rawDocument(db, actor, kind, ref.id);
  if (head.version !== ref.version)
    throw new AppError('VERSION_CONFLICT', '单据已更新，请刷新后重新操作。');
  const errors: FieldIssue[] = [];
  const fail = (path: string, code: string, message: string) =>
    errors.push({ path, code, message });
  const businessDate = await service.businessDate();
  if (!head.purpose.trim()) fail('purpose', 'REQUIRED', '请填写申请事由。');
  if (kind === 'travel' || kind === 'expense_claim') {
    if (!head.cost_center_id)
      fail('cost_center_id', 'REQUIRED', '请选择有效成本中心。');
    else {
      const [center] = await rows<{ id: string }>(
        db,
        sql`SELECT id FROM cost_centers WHERE tenant_id=${actor.tenant_id} AND id=${head.cost_center_id} AND department_id=${head.department_id} AND state='active' AND valid_from<=${businessDate}::date AND (valid_to IS NULL OR valid_to>=${businessDate}::date)`,
      );
      if (!center)
        fail(
          'cost_center_id',
          'INVALID_COST_CENTER',
          '成本中心已失效或不属于申请部门。',
        );
    }
  }
  if (kind === 'travel') {
    const legs = await rows<{ data: unknown }>(
      db,
      sql`SELECT data FROM travel_legs WHERE tenant_id=${actor.tenant_id} AND travel_id=${ref.id} ORDER BY ordinal`,
    );
    if (!legs.length) fail('legs', 'REQUIRED', '请至少填写一段行程。');
    for (const [index, entry] of legs.entries()) {
      const leg = TravelLegSchema.parse(entry.data);
      for (const field of [
        'from_city_id',
        'to_city_id',
        'departure_date',
        'end_date',
        'transport_budget',
      ] as const)
        if (leg[field] === null)
          fail(`legs.${index}.${field}`, 'REQUIRED', '请补齐行程字段。');
      for (const cityId of [leg.from_city_id, leg.to_city_id].filter(
        (id): id is string => id !== null,
      )) {
        const [city] = await rows<{ id: string }>(
          db,
          sql`SELECT id FROM cities WHERE tenant_id=${actor.tenant_id} AND id=${cityId} AND level='city' AND state='active'`,
        );
        if (!city)
          fail(`legs.${index}`, 'CITY_UNRESOLVED', '请选择已确认的标准城市。');
      }
      if (leg.lodging_required)
        for (const field of [
          'check_in',
          'check_out',
          'room_count',
          'nightly_room_budget',
        ] as const)
          if (leg[field] === null)
            fail(`legs.${index}.${field}`, 'REQUIRED', '请补齐住宿信息。');
    }
  } else if (kind === 'oa_request') {
    if (!head.entertainment_date)
      fail('entertainment_date', 'REQUIRED', '请填写招待日期。');
    else if (String(head.entertainment_date) < businessDate)
      fail(
        'entertainment_date',
        'PAST_DATE',
        '新申请的招待日期不能早于业务日期。',
      );
    if (!String(head.entertained_party ?? '').trim())
      fail('entertained_party', 'REQUIRED', '请填写招待对象。');
    if (head.budget_minor == null || BigInt(head.budget_minor) <= 0n)
      fail('budget', 'REQUIRED', '请填写大于零的预算。');
  } else {
    const entries = await rows<{ data: unknown }>(
      db,
      sql`SELECT data FROM expense_items WHERE tenant_id=${actor.tenant_id} AND claim_id=${ref.id} ORDER BY id`,
    );
    if (!entries.length) fail('items', 'REQUIRED', '请至少绑定一条费用。');
    const oaTotals = new Map<string, bigint>();
    for (const entry of entries) {
      const item = ExpenseItemSchema.parse(entry.data);
      if (item.oa_ref)
        oaTotals.set(
          item.oa_ref.id,
          (oaTotals.get(item.oa_ref.id) ?? 0n) +
            BigInt(item.claim_amount.amount_minor),
        );
    }
    for (const [index, entry] of entries.entries()) {
      const item = ExpenseItemSchema.parse(entry.data);
      const [invoice] = await rows<{
        owner_id: string;
        version: number;
        confirmation_state: string;
        fields: Record<string, unknown>;
        gross_minor: string;
        verification_state: string;
      }>(
        db,
        sql`SELECT owner_id,version,confirmation_state,fields,gross_minor::text,verification_state FROM invoices WHERE tenant_id=${actor.tenant_id} AND id=${item.invoice_id}`,
      );
      if (!invoice || invoice.owner_id !== head.owner_id) {
        fail(
          `items.${index}.invoice_id`,
          'INVOICE_UNAVAILABLE',
          '票据不可用于本次提交。',
        );
        continue;
      }
      if (invoice.version !== item.invoice_version)
        fail(
          `items.${index}.invoice_version`,
          'INVOICE_VERSION_CHANGED',
          '票据字段已更新，请重新核对。',
        );
      if (
        invoice.confirmation_state !== 'confirmed' ||
        !invoice.fields.invoice_number ||
        !invoice.fields.seller_name ||
        !invoice.fields.buyer_name ||
        !invoice.fields.invoice_date ||
        invoice.fields.gross_amount === null
      )
        fail(
          `items.${index}.invoice_id`,
          'INVOICE_INCOMPLETE',
          '请先核对完整票面字段。',
        );
      if (item.type_confirmation !== 'confirmed')
        fail(
          `items.${index}.expense_type`,
          'TYPE_UNCONFIRMED',
          '请明确确认费用类型。',
        );
      if (item.incurred_date > businessDate)
        fail(
          `items.${index}.incurred_date`,
          'FUTURE_DATE',
          '费用发生日期不能晚于业务日期。',
        );
      if (
        BigInt(item.claim_amount.amount_minor) >
        BigInt(invoice.gross_minor ?? '0')
      )
        fail(
          `items.${index}.claim_amount`,
          'AMOUNT_MISMATCH',
          '申报金额不能超过票面金额。',
        );
      if (item.expense_type === 'lodging' && !item.lodging_details)
        fail(
          `items.${index}.lodging_details`,
          'REQUIRED',
          '住宿费用需要完整间夜信息。',
        );
      if (item.travel_ref) {
        const travel = await service.get(
          actor,
          'travel',
          item.travel_ref.id,
          db,
        );
        if (
          travel.version !== item.travel_ref.version ||
          travel.state !== 'approved'
        )
          fail(
            `items.${index}.travel_ref`,
            'TRAVEL_NOT_APPROVED',
            '关联差旅需要是当前已批准版本。',
          );
        const legs =
          (
            travel as {
              legs?: Array<{
                departure_date: string | null;
                end_date: string | null;
              }>;
            }
          ).legs ?? [];
        if (
          !legs.some(
            (leg) =>
              leg.departure_date &&
              leg.end_date &&
              leg.departure_date <= item.incurred_date &&
              leg.end_date >= item.incurred_date,
          )
        )
          fail(
            `items.${index}.incurred_date`,
            'TRAVEL_DATE_MISMATCH',
            '费用日期需要落在已批准行程内。',
          );
      }
      if (item.expense_type === 'meals') {
        if (item.expense_subtype !== 'business_entertainment' || !item.oa_ref) {
          fail(
            `items.${index}.oa_ref`,
            'OA_REQUIRED',
            '业务招待餐饮需关联已批准的前置申请。',
          );
          continue;
        }
        const oa = await rawDocument(db, actor, 'oa_request', item.oa_ref.id);
        if (oa.owner_id !== head.owner_id) {
          fail(
            `items.${index}.oa_ref`,
            'OA_OWNER_MISMATCH',
            '该前置申请不能用于本报销。',
          );
          continue;
        }
        if (oa.state !== 'approved')
          fail(
            `items.${index}.oa_ref`,
            'OA_NOT_APPROVED',
            '前置申请尚未批准。',
          );
        if (oa.version !== item.oa_ref.version)
          fail(
            `items.${index}.oa_ref`,
            'OA_VERSION_CHANGED',
            '前置申请版本已变化。',
          );
        if (String(oa.entertainment_date) !== item.incurred_date)
          fail(
            `items.${index}.incurred_date`,
            'OA_DATE_MISMATCH',
            '费用日期应与招待日期一致。',
          );
        const [selfReservation] = await rows<{ amount: string }>(
          db,
          sql`SELECT coalesce(sum(amount_minor),0)::text AS amount FROM oa_budget_reservations WHERE tenant_id=${actor.tenant_id} AND oa_id=${oa.id} AND claim_id=${ref.id} AND state='reserved'`,
        );
        if (
          BigInt(oa.consumed_minor as string) +
            BigInt(oa.reserved_minor as string) -
            BigInt(selfReservation?.amount ?? '0') +
            (oaTotals.get(oa.id) ?? 0n) >
          BigInt(oa.budget_minor ?? 0)
        )
          fail(
            `items.${index}.claim_amount`,
            'OA_BUDGET_EXCEEDED',
            '前置申请可用额度不足。',
          );
      }
    }
  }
  return {
    document: { type: kind, id: ref.id, version: head.version },
    valid: errors.length === 0,
    errors,
    warnings: [],
    checks: { business_date: businessDate },
  };
}
