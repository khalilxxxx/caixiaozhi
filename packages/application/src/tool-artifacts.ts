import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { ExecutionContext } from '@caixiaozhi/contracts/integrations';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import type { Storage } from '@caixiaozhi/platform/storage';
import type { RunService } from '@caixiaozhi/agent-runtime';
import { canonicalJson } from '@caixiaozhi/platform/hash';
import { AppError } from '@caixiaozhi/platform/errors';
export function createToolArtifacts(options: {
  database: DatabaseConnection;
  storage: Storage;
  runs: RunService;
  freshActor: (actor: ActorContext) => Promise<ActorContext>;
}) {
  const { database, storage, runs } = options;
  const sha = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  async function store(ctx: ExecutionContext, output: unknown) {
    const actor = await options.freshActor(ctx.actor);
    await runs.getRun(actor, ctx.run_id);
    await runs.assertLease(ctx.run_id, ctx.lease_epoch);
    if (
      actor.tenant_id !== ctx.actor.tenant_id ||
      actor.user_id !== ctx.actor.user_id ||
      actor.authz_version !== ctx.actor.authz_version
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '工具产物的授权上下文已变化。',
      );
    const bytes = Buffer.from(canonicalJson(output));
    if (bytes.length > 20_971_520)
      throw new AppError(
        'VALIDATION_ERROR',
        '工具产物超过20MiB限制，请缩小查询范围。',
      );
    const id = randomUUID(),
      key = `tool-artifacts/${encodeURIComponent(actor.tenant_id)}/${id}.json`,
      hash = sha(bytes);
    try {
      await storage.putObject({
        key,
        body: bytes,
        contentType: 'application/json',
      });
      const fresh = await options.freshActor(actor);
      if (
        fresh.tenant_id !== actor.tenant_id ||
        fresh.user_id !== actor.user_id ||
        fresh.authz_version !== actor.authz_version ||
        !Number.isFinite(Date.parse(ctx.deadline_at)) ||
        Date.now() >= Date.parse(ctx.deadline_at)
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '工具产物完成前上下文或期限已变化。',
        );
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        const identity = (
          await client.query(
            'SELECT authz_version,state FROM identities WHERE tenant_id=$1 AND id=$2 FOR SHARE',
            [actor.tenant_id, actor.user_id],
          )
        ).rows[0];
        if (
          !identity ||
          identity.state !== 'active' ||
          Number(identity.authz_version) !== actor.authz_version
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '工具产物提交前权限已变化。',
          );
        const origin =
          fresh.invocation_origin === 'interactive'
            ? await client.query(
                "SELECT s.id FROM identity_sessions s JOIN identity_environments e ON e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.actor_id=$2 AND s.id=$3 AND s.generation=e.generation AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-interval '30 minutes' FOR SHARE OF s,e",
                [actor.tenant_id, actor.user_id, fresh.session_id],
              )
            : await client.query(
                "SELECT d.id FROM subscription_delegations d JOIN identity_environments e ON e.tenant_id=d.tenant_id WHERE d.tenant_id=$1 AND d.owner_id=$2 AND d.id=$3 AND d.generation=e.generation AND d.state='active' FOR SHARE OF d,e",
                [actor.tenant_id, actor.user_id, fresh.delegation_id],
              );
        if (!origin.rowCount)
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '工具产物提交前会话或订阅授权已失效。',
          );
        const lease = await client.query(
          "SELECT r.id FROM agent_runs r JOIN run_leases l ON l.run_id=r.id WHERE r.id=$1 AND r.tenant_id=$2 AND r.owner_id=$3 AND r.authz_version=$4 AND r.status='running' AND r.runtime_active AND r.cancel_requested_at IS NULL AND l.lease_epoch=$5 AND l.lease_until>clock_timestamp() FOR SHARE OF r,l",
          [
            ctx.run_id,
            actor.tenant_id,
            actor.user_id,
            actor.authz_version,
            ctx.lease_epoch,
          ],
        );
        if (!lease.rowCount)
          throw new AppError(
            'INVALID_STATE',
            '工具产物所属运行或租约已失效。',
            { details: { reason: 'LEASE_LOST' } },
          );
        const saved = await client.query(
          'INSERT INTO tool_artifacts(tenant_id,id,owner_id,run_id,lease_epoch,authz_version,object_key,sha256,size_bytes) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 FROM run_leases WHERE run_id=$4 AND lease_epoch=$5 AND lease_until>clock_timestamp() AND clock_timestamp()<$10::timestamptz RETURNING id',
          [
            actor.tenant_id,
            id,
            actor.user_id,
            ctx.run_id,
            ctx.lease_epoch,
            actor.authz_version,
            key,
            hash,
            bytes.length,
            ctx.deadline_at,
          ],
        );
        if (!saved.rowCount)
          throw new AppError(
            'INVALID_STATE',
            '工具产物提交时租约或期限已失效。',
            { details: { reason: 'LEASE_LOST' } },
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await storage.deleteObject(key).catch(() => {});
      throw error;
    }
    return {
      artifact_ref: `artifact:${id}`,
      summary: {
        artifact_id: id,
        size_bytes: bytes.length,
        sha256: hash,
        description:
          '工具结果超过流式输出上限，完整JSON已保存到需当前身份鉴权的私有产物。',
      },
    };
  }
  async function download(actor: ActorContext, runId: string, id: string) {
    actor = await options.freshActor(actor);
    await runs.getRun(actor, runId);
    const result = await database.pool.query(
      'SELECT object_key,sha256,size_bytes,authz_version FROM tool_artifacts WHERE tenant_id=$1 AND owner_id=$2 AND run_id=$3 AND id=$4 AND expires_at>clock_timestamp()',
      [actor.tenant_id, actor.user_id, runId, id],
    );
    const row = result.rows[0];
    if (!row || Number(row.authz_version) !== actor.authz_version)
      throw new AppError('NOT_FOUND', '产物不存在、已过期或当前无权读取。');
    const { body: bytes } = await storage.getObject(row.object_key);
    if (sha(bytes) !== row.sha256 || bytes.length !== row.size_bytes)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '产物完整性校验未通过。');
    const fresh = await options.freshActor(actor);
    if (
      fresh.tenant_id !== actor.tenant_id ||
      fresh.user_id !== actor.user_id ||
      fresh.authz_version !== Number(row.authz_version)
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '工具产物读取期间权限已变化。',
      );
    await runs.getRun(fresh, runId);
    const live = await database.pool.query(
      'SELECT id FROM tool_artifacts WHERE tenant_id=$1 AND owner_id=$2 AND run_id=$3 AND id=$4 AND authz_version=$5 AND expires_at>clock_timestamp()',
      [fresh.tenant_id, fresh.user_id, runId, id, fresh.authz_version],
    );
    if (!live.rowCount)
      throw new AppError('NOT_FOUND', '产物已过期或当前无权读取。');
    return { id, bytes };
  }
  return { store, download };
}
