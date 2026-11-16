import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import { ExpenseItemSchema } from '@caixiaozhi/contracts/expenses';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { rows, rawDocument, validation } from './store.js';

export async function reserveOaBudget(
  db: DatabaseExecutor,
  actor: ActorContext,
  claimId: string,
  submissionId: string,
) {
  const entries = await rows<{ data: unknown }>(
    db,
    sql`SELECT data FROM expense_items WHERE tenant_id=${actor.tenant_id} AND claim_id=${claimId} ORDER BY id`,
  );
  const claims = await rawDocument(db, actor, 'expense_claim', claimId);
  const allocations = new Map<
    string,
    { amount: bigint; version: number; dates: Set<string> }
  >();
  for (const entry of entries) {
    const item = ExpenseItemSchema.parse(entry.data);
    if (item.expense_type !== 'meals') continue;
    if (!item.oa_ref || item.expense_subtype !== 'business_entertainment')
      throw validation('招待餐饮费用需要关联前置申请。');
    const previous = allocations.get(item.oa_ref.id) ?? {
      amount: 0n,
      version: item.oa_ref.version,
      dates: new Set<string>(),
    };
    if (previous.version !== item.oa_ref.version)
      throw validation('同一前置申请的引用版本不一致。');
    previous.amount += BigInt(item.claim_amount.amount_minor);
    previous.dates.add(item.incurred_date);
    allocations.set(item.oa_ref.id, previous);
  }
  for (const [oaId, allocation] of [...allocations].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const oa = await rawDocument(db, actor, 'oa_request', oaId, true);
    if (
      oa.owner_id !== claims.owner_id ||
      oa.state !== 'approved' ||
      oa.version !== allocation.version ||
      allocation.dates.size !== 1 ||
      !allocation.dates.has(String(oa.entertainment_date))
    )
      throw validation('前置申请状态、归属、日期或版本不匹配。');
    const [prior] = await rows<{ amount_minor: string; state: string }>(
      db,
      sql`SELECT amount_minor::text,state FROM oa_budget_reservations WHERE tenant_id=${actor.tenant_id} AND oa_id=${oaId} AND claim_id=${claimId} AND submission_id=${submissionId}`,
    );
    if (prior) {
      if (
        BigInt(prior.amount_minor) !== allocation.amount ||
        prior.state !== 'reserved'
      )
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '本次提交的额度占用参数已变化。',
        );
      continue;
    }
    if (
      BigInt(oa.consumed_minor as string) +
        BigInt(oa.reserved_minor as string) +
        allocation.amount >
      BigInt(oa.budget_minor ?? '0')
    )
      throw validation('前置申请可用额度不足。', [
        { code: 'OA_BUDGET_EXCEEDED', path: 'items' },
      ]);
    await db.execute(
      sql`INSERT INTO oa_budget_reservations(tenant_id,id,oa_id,claim_id,submission_id,reservation_key,amount_minor,state) VALUES(${actor.tenant_id},${randomUUID()},${oaId},${claimId},${submissionId},${`${claimId}:${submissionId}:${oaId}`},${allocation.amount.toString()},'reserved')`,
    );
    await db.execute(
      sql`UPDATE entertainment_requests SET reserved_minor=reserved_minor+${allocation.amount.toString()}::bigint,updated_at=clock_timestamp() WHERE tenant_id=${actor.tenant_id} AND id=${oaId}`,
    );
  }
}
export async function settleOaBudget(
  db: DatabaseExecutor,
  actor: ActorContext,
  claimId: string,
  submissionId: string,
  mode: 'release' | 'consume',
) {
  const reservations = await rows<{
    id: string;
    oa_id: string;
    amount_minor: string;
  }>(
    db,
    sql`SELECT id,oa_id,amount_minor::text FROM oa_budget_reservations WHERE tenant_id=${actor.tenant_id} AND claim_id=${claimId} AND submission_id=${submissionId} AND state='reserved' ORDER BY oa_id,id FOR UPDATE`,
  );
  for (const reservation of reservations) {
    await rawDocument(db, actor, 'oa_request', reservation.oa_id, true);
    await db.execute(
      sql`UPDATE entertainment_requests SET reserved_minor=reserved_minor-${reservation.amount_minor}::bigint,consumed_minor=consumed_minor+${mode === 'consume' ? reservation.amount_minor : '0'}::bigint,updated_at=clock_timestamp() WHERE tenant_id=${actor.tenant_id} AND id=${reservation.oa_id}`,
    );
    await db.execute(
      sql`UPDATE oa_budget_reservations SET state=${mode === 'consume' ? 'consumed' : 'released'},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${actor.tenant_id} AND id=${reservation.id} AND state='reserved'`,
    );
  }
}
