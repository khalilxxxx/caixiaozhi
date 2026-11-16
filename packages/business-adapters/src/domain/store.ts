import { randomUUID } from 'node:crypto';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  ResourceRef,
  Money,
} from '@caixiaozhi/contracts/common';
import { AppError } from '@caixiaozhi/platform/errors';
import type {
  DatabaseConnection,
  DatabaseExecutor,
  Transaction,
} from '@caixiaozhi/platform/database';
import type { IdentityService } from '@caixiaozhi/identity';
import { enqueueOutbox } from '@caixiaozhi/jobs/outbox';

export type BusinessKind = 'travel' | 'expense_claim' | 'oa_request';
export const documentTables = {
  travel: 'travel_requests',
  expense_claim: 'expense_claims',
  oa_request: 'entertainment_requests',
} as const;
export type DocumentHead = {
  tenant_id: string;
  id: string;
  owner_id: string;
  department_id: string;
  version: number;
  state: string;
  title: string;
  purpose: string;
  cost_center_id?: string | null;
  material_refs?: unknown[];
  total_minor?: string;
  budget_minor?: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  approved_at?: Date | null;
  completed_at?: Date | null;
  submission_id: string | null;
  [key: string]: unknown;
};
export async function rows<T>(
  db: DatabaseExecutor,
  statement: SQL,
): Promise<T[]> {
  const result = await db.execute(statement);
  return result.rows as T[];
}
export function money(
  amount: string | number | bigint | null | undefined,
): Money {
  return { amount_minor: String(amount ?? 0), currency: 'CNY' };
}
export const missing = () => new AppError('NOT_FOUND', '请求的资源不存在。');
export const conflict = () =>
  new AppError('VERSION_CONFLICT', '单据已更新，请刷新后重新操作。');
export function validation(message: string, fields: unknown[] = []) {
  return new AppError('VALIDATION_ERROR', message, { details: { fields } });
}
export async function idempotent<T>(
  db: DatabaseConnection,
  actor: ActorContext,
  operation: string,
  key: string,
  payload: unknown,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw validation('修改请求需要有效的 Idempotency-Key。');
  const hash = canonicalHash(payload);
  return db.db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO business_command_ledger(tenant_id,actor_id,operation,idempotency_key,payload_hash) VALUES(${actor.tenant_id},${actor.user_id},${operation},${key},${hash}) ON CONFLICT DO NOTHING`,
    );
    const [record] = await rows<{ payload_hash: string; result: T | null }>(
      tx,
      sql`SELECT payload_hash,result FROM business_command_ledger WHERE tenant_id=${actor.tenant_id} AND actor_id=${actor.user_id} AND operation=${operation} AND idempotency_key=${key} FOR UPDATE`,
    );
    if (!record || record.payload_hash !== hash)
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        '同一幂等键已用于不同的请求。',
      );
    if (record.result !== null) return record.result;
    const result = await work(tx);
    await tx.execute(
      sql`UPDATE business_command_ledger SET result=${JSON.stringify(result)}::jsonb WHERE tenant_id=${actor.tenant_id} AND actor_id=${actor.user_id} AND operation=${operation} AND idempotency_key=${key}`,
    );
    return result;
  });
}
export async function rawDocument(
  db: DatabaseExecutor,
  actor: Pick<ActorContext, 'tenant_id'>,
  kind: BusinessKind,
  id: string,
  lock = false,
): Promise<DocumentHead> {
  const [head] = await rows<DocumentHead>(
    db,
    sql`SELECT *,${sql.raw(kind === 'oa_request' ? 'budget_minor' : 'total_minor')}::text AS ${sql.raw(kind === 'oa_request' ? 'budget_minor' : 'total_minor')} ${kind === 'oa_request' ? sql`, entertainment_date::text AS entertainment_date` : sql``} FROM ${sql.raw(documentTables[kind])} WHERE tenant_id=${actor.tenant_id} AND id=${id} ${lock ? sql`FOR UPDATE` : sql``}`,
  );
  if (!head) throw missing();
  return head;
}
export async function recordDocumentEvent(
  tx: Transaction,
  actor: ActorContext,
  kind: BusinessKind,
  id: string,
  version: number,
  eventType: string,
) {
  await enqueueOutbox(
    tx,
    {
      tenantId: actor.tenant_id,
      eventType,
      resourceType: kind,
      resourceId: id,
      resourceVersion: version,
      payload: {
        resource: { type: kind, id, version },
        actor_id: actor.user_id,
      },
    },
    z.strictObject({
      resource: z.strictObject({
        type: z.enum(['travel', 'expense_claim', 'oa_request']),
        id: z.string(),
        version: z.number().int().positive(),
      }),
      actor_id: z.string(),
    }),
  );
}
export async function visibleList(
  db: DatabaseExecutor,
  identity: IdentityService,
  actor: ActorContext,
  kind: BusinessKind,
  input: { cursor?: string | null; limit?: number; state?: string } = {},
) {
  const prefix =
    kind === 'expense_claim'
      ? 'expense'
      : kind === 'oa_request'
        ? 'oa'
        : 'travel';
  const scope = await identity.getResourceScope(actor, `${prefix}.read`);
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const result = await rows<DocumentHead>(
    db,
    sql`SELECT *,${sql.raw(kind === 'oa_request' ? 'budget_minor' : 'total_minor')}::text AS ${sql.raw(kind === 'oa_request' ? 'budget_minor' : 'total_minor')} ${kind === 'oa_request' ? sql`, entertainment_date::text AS entertainment_date` : sql``} FROM ${sql.raw(documentTables[kind])} WHERE tenant_id=${actor.tenant_id} AND (owner_id=ANY(${sql.param(scope.owner_ids)}::text[]) OR department_id=ANY(${sql.param(scope.department_ids)}::text[]) OR id=ANY(${sql.param(scope.named_resource_ids)}::text[])) ${input.state ? sql`AND state=${input.state}` : sql``} ${input.cursor ? sql`AND id>${input.cursor}` : sql``} ORDER BY id LIMIT ${limit + 1}`,
  );
  return {
    items: result.slice(0, limit),
    next_cursor: result.length > limit ? result[limit - 1]!.id : null,
  };
}
export function assertEditable(
  head: DocumentHead,
  actor: ActorContext,
  version: number,
) {
  if (head.owner_id !== actor.user_id) throw missing();
  if (head.version !== version) throw conflict();
  if (!['draft', 'returned', 'withdrawn'].includes(head.state))
    throw new AppError(
      'INVALID_STATE',
      '当前状态不能修改，请先按流程退回或撤回。',
    );
}
export async function snapshot(
  tx: DatabaseExecutor,
  actor: ActorContext,
  ref: ResourceRef,
  body: unknown,
) {
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO business_snapshots(tenant_id,id,resource_type,resource_id,resource_version,body) VALUES(${actor.tenant_id},${id},${ref.type},${ref.id},${ref.version},${JSON.stringify(body)}::jsonb)`,
  );
  return id;
}
