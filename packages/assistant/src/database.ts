import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@caixiaozhi/contracts';
import { AppError } from '@caixiaozhi/platform/errors';
import { runPayloadHash } from '@caixiaozhi/agent-runtime';
export type Row = Record<string, any>;
export const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value === null
      ? null
      : String(value);
export async function transaction<T>(
  database: DatabaseConnection,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function lockOwner(client: PoolClient, actor: ActorContext) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `assistant:${actor.tenant_id}:${actor.user_id}`,
  ]);
}
export async function idempotent<T>(
  database: DatabaseConnection,
  actor: ActorContext,
  operation: string,
  key: string,
  input: unknown,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw new AppError('VALIDATION_ERROR', '请提供有效的 Idempotency-Key。');
  return transaction(database, async (client) => {
    await lockOwner(client, actor);
    const old = await client.query(
      'SELECT * FROM assistant_commands WHERE tenant_id=$1 AND owner_id=$2 AND operation=$3 AND key=$4',
      [actor.tenant_id, actor.user_id, operation, key],
    );
    if (old.rows[0]) {
      if (old.rows[0].payload_hash !== runPayloadHash(input))
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '该请求标识已用于不同内容。',
        );
      return old.rows[0].result as T;
    }
    const result = await fn(client);
    await client.query(
      'INSERT INTO assistant_commands(tenant_id,owner_id,operation,key,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenant_id,
        actor.user_id,
        operation,
        key,
        runPayloadHash(input),
        JSON.stringify(result),
      ],
    );
    return result;
  });
}
export async function outbox(
  client: PoolClient,
  actor: Pick<ActorContext, 'tenant_id'>,
  type: string,
  id: string,
  version: number,
  payload: unknown,
) {
  await client.query(
    `INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload) VALUES($1,$2,$3,1,'assistant',$4,$5,now(),$6)`,
    [randomUUID(), actor.tenant_id, type, id, version, JSON.stringify(payload)],
  );
}
