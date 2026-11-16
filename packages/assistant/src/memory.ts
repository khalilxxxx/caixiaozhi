import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  ActorContext,
  Permission,
  ResourceRef,
} from '@caixiaozhi/contracts';
import { AgentCardSchema } from '@caixiaozhi/contracts/cards';
import {
  DigestResultSchema,
  MemoryInputSchema,
  SubscriptionInputSchema,
  type DigestResult,
  type DigestQuery,
  type MemoryInput,
  type SubscriptionInput,
} from '@caixiaozhi/contracts/memory';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDurableQueue } from '@caixiaozhi/jobs/queue';
import { idempotent, iso, outbox, transaction, type Row } from './database.js';
import { localDateTime, nextOccurrence, schedulePreview } from './schedule.js';

// 独立生产/测试租户没有Demo记录；受控租户只处理当前且ready的一代。
const currentDigestTenantSql = (
  column: 's.tenant_id' | 'j.tenant_id' | 'e.tenant_id',
) =>
  `NOT EXISTS (SELECT 1 FROM demo_environments env WHERE
    (env.active_tenant_id=${column} OR EXISTS (SELECT 1 FROM demo_generation_manifests generation WHERE generation.env_id=env.id AND generation.namespace_ref=${column}))
    AND (env.active_tenant_id<>${column} OR env.lifecycle<>'ready'))`;

export type MemoryServiceOptions = {
  freshActor: (actor: ActorContext) => Promise<ActorContext>;
  createDelegation?: (
    actor: ActorContext,
    input: { subscriptionId: string; allowedCapabilities: Permission[] },
  ) => Promise<{ id: string; version: number }>;
  resolveDelegation?: (
    tenantId: string,
    delegationId: string,
  ) => Promise<ActorContext>;
  revokeDelegation?: (actor: ActorContext, id: string) => Promise<void>;
  authorizeResource?: (
    actor: ActorContext,
    ref: ResourceRef,
  ) => Promise<ResourceRef>;
  validateSkill?: (
    actor: ActorContext,
    id: string,
  ) => Promise<{ tools: Array<{ effect: string }> }>;
  readDigest?: (
    actor: ActorContext,
    type: string,
    query: DigestQuery,
  ) => Promise<DigestResult>;
  clock?: () => Date;
  businessNow?: () => Promise<Date>;
};
const readPermissions = (actor: ActorContext, includeSkill = false) =>
  actor.permissions.filter(
    (p) =>
      p.includes('.read.') ||
      p === 'analytics.query' ||
      (includeSkill && p === 'skill.use'),
  ) as Permission[];
function assertMemoryContent(input: MemoryInput) {
  const text = `${input.key} ${input.content} ${JSON.stringify(input.value)}`;
  if (
    /(超过|超出|低于|阈值|限额|审核|预审|风险|报销标准|审批条件).{0,20}(\d|元|金额|餐饮|住宿)|\d.{0,12}(元|费用).{0,15}(提醒|关注|风险|审批)/i.test(
      text,
    )
  )
    throw new AppError(
      'VALIDATION_ERROR',
      '审核金额或风险条件需要保存为个人规则。',
      {
        details: {
          reason: 'RULE_THRESHOLD_REQUIRES_RULE',
          destination: '/rules',
        },
      },
    );
  if (
    /(api[_ -]?key|access[_ -]?token|password|密码|口令|银行卡号)\s*[:：=]|\b\d{16,19}\b/i.test(
      text,
    )
  )
    throw new AppError(
      'VALIDATION_ERROR',
      '记忆中不能保存口令、令牌或完整银行卡号。',
    );
}
const publicMemory = (row: Row) => ({
  id: row.id,
  tenant_id: row.tenant_id,
  owner_id: row.owner_id,
  version: row.version,
  kind: row.kind,
  key: row.key,
  content: row.status === 'deleted' ? null : row.content,
  value: row.status === 'deleted' ? null : row.value_json,
  status: row.status,
  source: {
    kind: row.source_kind,
    ...(row.source_message_id ? { message_id: row.source_message_id } : {}),
  },
  expires_at: iso(row.expires_at),
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});
const publicSubscription = (row: Row) => ({
  id: row.id,
  version: row.version,
  type: row.type,
  title: row.title,
  query_spec: row.query_spec,
  schedule: row.schedule_json,
  schedule_version: row.schedule_version,
  status: row.status,
  next_run_at: iso(row.next_run_at),
  skill_version_id: row.skill_version_id,
  error_code: row.error_code,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
});
export function createMemoryService(
  database: DatabaseConnection,
  options: MemoryServiceOptions,
) {
  const now = options.clock ?? (() => new Date());
  const queue = createDurableQueue(database);
  async function own(
    client: Pick<PoolClient, 'query'>,
    table: 'memories' | 'subscriptions' | 'inbox_items',
    actor: ActorContext,
    id: string,
    lock = false,
  ): Promise<Row> {
    const result = await client.query(
      `SELECT * FROM ${table} WHERE tenant_id=$1 AND owner_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`,
      [actor.tenant_id, actor.user_id, id],
    );
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '记录不存在。');
    return result.rows[0];
  }
  async function epoch(client: Pick<PoolClient, 'query'>, actor: ActorContext) {
    const result = await client.query(
      'INSERT INTO memory_profiles(tenant_id,owner_id,memory_epoch) VALUES($1,$2,1) ON CONFLICT(tenant_id,owner_id) DO UPDATE SET memory_epoch=memory_profiles.memory_epoch+1,updated_at=now() RETURNING memory_epoch',
      [actor.tenant_id, actor.user_id],
    );
    await outbox(
      client as PoolClient,
      actor,
      'memory.invalidated',
      actor.user_id,
      result.rows[0].memory_epoch,
      { owner_id: actor.user_id, memory_epoch: result.rows[0].memory_epoch },
    );
    return result.rows[0].memory_epoch as number;
  }
  async function validateSource(
    client: PoolClient,
    actor: ActorContext,
    input: MemoryInput,
  ) {
    if (input.source.kind === 'explicit_message') {
      const result = await client.query(
        `SELECT m.content FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.tenant_id=$1 AND m.owner_id=$2 AND m.id=$3 AND m.role='user' AND t.deleted_at IS NULL`,
        [actor.tenant_id, actor.user_id, input.source.message_id],
      );
      if (
        !result.rows[0] ||
        !/(记住|保存.*记忆|记下来)/.test(result.rows[0].content)
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '来源消息没有可验证的明确保存指令。',
        );
    }
  }
  async function validateSubscription(
    actor: ActorContext,
    input: SubscriptionInput,
  ) {
    if (!options.createDelegation || !options.resolveDelegation)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '订阅授权服务尚未就绪。');
    const permissions = readPermissions(actor, Boolean(input.skill_version_id));
    if (!permissions.length)
      throw new AppError('FORBIDDEN', '没有可用于摘要的读取权限。');
    if (
      input.type === 'expense_digest' &&
      !actor.permissions.includes('analytics.query')
    )
      throw new AppError('FORBIDDEN', '没有费用分析权限。');
    if (input.query_spec.scope === 'documents') {
      for (const ref of input.query_spec.resource_refs) {
        if (!options.authorizeResource)
          throw new AppError('NOT_FOUND', '单据不可查看。');
        await options.authorizeResource(actor, ref);
      }
    }
    if (input.skill_version_id) {
      if (!options.validateSkill)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          'Skill 校验服务尚未就绪。',
        );
      const skill = await options.validateSkill(actor, input.skill_version_id);
      if (skill.tools.some((tool) => tool.effect !== 'read'))
        throw new AppError(
          'FORBIDDEN',
          '后台摘要只能使用全部为只读能力的 Skill。',
        );
    }
    return permissions;
  }
  async function delegated(subscription: Row) {
    if (!options.resolveDelegation)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '订阅授权服务尚未就绪。');
    return options.resolveDelegation(
      subscription.tenant_id,
      subscription.delegation_id,
    );
  }
  async function visibleDigest(actor: ActorContext, item: Row) {
    const result = await database.pool.query(
      'SELECT * FROM digest_snapshots WHERE tenant_id=$1 AND id=$2',
      [actor.tenant_id, item.summary_id],
    );
    const snapshot = result.rows[0];
    if (!snapshot || snapshot.authz_version !== actor.authz_version)
      throw new AppError('NOT_FOUND', '摘要已不可查看。');
    const refs = snapshot.source_refs as ResourceRef[];
    for (const ref of refs) {
      if (!options.authorizeResource)
        throw new AppError('NOT_FOUND', '摘要已不可查看。');
      await options.authorizeResource(actor, ref);
    }
    return snapshot;
  }
  const service = {
    async listMemories(actor: ActorContext) {
      actor = await options.freshActor(actor);
      await service.selectMemoryContext(actor, []);
      const result = await database.pool.query(
        'SELECT * FROM memories WHERE tenant_id=$1 AND owner_id=$2 ORDER BY updated_at DESC,id LIMIT 100',
        [actor.tenant_id, actor.user_id],
      );
      return {
        items: result.rows.map(publicMemory),
        memory_epoch: await service.memoryEpoch(actor),
        next_cursor: null,
      };
    },
    async memoryEpoch(actor: ActorContext) {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        'SELECT memory_epoch FROM memory_profiles WHERE tenant_id=$1 AND owner_id=$2',
        [actor.tenant_id, actor.user_id],
      );
      return Number(result.rows[0]?.memory_epoch ?? 0);
    },
    async assertMemoryEpoch(actor: ActorContext, expected: number) {
      if ((await service.memoryEpoch(actor)) !== expected)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '个人记忆已更新，正在重新组织上下文。',
          { details: { reason: 'MEMORY_EPOCH_CHANGED' } },
        );
    },
    async saveMemory(actor: ActorContext, input: unknown, key: string) {
      actor = await options.freshActor(actor);
      const parsed = MemoryInputSchema.parse(input);
      assertMemoryContent(parsed);
      if (parsed.expires_at && new Date(parsed.expires_at) <= now())
        throw new AppError('VALIDATION_ERROR', '记忆有效期应晚于当前时间。');
      return idempotent(
        database,
        actor,
        'memory.save',
        key,
        parsed,
        async (client) => {
          await validateSource(client, actor, parsed);
          const exists = await client.query(
            "SELECT * FROM memories WHERE tenant_id=$1 AND owner_id=$2 AND kind=$3 AND key=$4 AND status='active'",
            [actor.tenant_id, actor.user_id, parsed.kind, parsed.key],
          );
          if (exists.rows[0]) {
            if (
              exists.rows[0].content === parsed.content &&
              JSON.stringify(exists.rows[0].value_json) ===
                JSON.stringify(parsed.value)
            )
              return {
                memory: publicMemory(exists.rows[0]),
                memory_epoch: await service.memoryEpoch(actor),
              };
            throw new AppError(
              'VERSION_CONFLICT',
              '已有同名偏好，请查看差异后编辑。',
              {
                details: {
                  memory_id: exists.rows[0].id,
                  current_version: exists.rows[0].version,
                },
              },
            );
          }
          const sourceId =
            parsed.source.kind === 'explicit_message'
              ? parsed.source.message_id
              : null;
          const result = await client.query(
            "INSERT INTO memories(id,tenant_id,owner_id,kind,key,content,value_json,status,source_kind,source_message_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10) RETURNING *",
            [
              randomUUID(),
              actor.tenant_id,
              actor.user_id,
              parsed.kind,
              parsed.key,
              parsed.content,
              JSON.stringify(parsed.value),
              parsed.source.kind,
              sourceId,
              parsed.expires_at,
            ],
          );
          await client.query(
            'INSERT INTO memory_revisions(tenant_id,memory_id,revision,content,value_json,change_reason) VALUES($1,$2,1,$3,$4,$5)',
            [
              actor.tenant_id,
              result.rows[0].id,
              parsed.content,
              JSON.stringify(parsed.value),
              'explicit_save',
            ],
          );
          return {
            memory: publicMemory(result.rows[0]),
            memory_epoch: await epoch(client, actor),
          };
        },
      );
    },
    async updateMemory(
      actor: ActorContext,
      id: string,
      input: MemoryInput & { expected_version: number },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const { expected_version, ...raw } = input;
      const parsed = MemoryInputSchema.parse(raw);
      assertMemoryContent(parsed);
      return idempotent(
        database,
        actor,
        `memory.update:${id}`,
        key,
        input,
        async (client) => {
          const old = await own(client, 'memories', actor, id, true);
          if (old.version !== expected_version)
            throw new AppError('VERSION_CONFLICT', '记忆已更新。');
          await validateSource(client, actor, parsed);
          const result = await client.query(
            "UPDATE memories SET kind=$2,key=$3,content=$4,value_json=$5,status='active',source_kind=$6,source_message_id=$7,expires_at=$8,deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [
              id,
              parsed.kind,
              parsed.key,
              parsed.content,
              JSON.stringify(parsed.value),
              parsed.source.kind,
              parsed.source.kind === 'explicit_message'
                ? parsed.source.message_id
                : null,
              parsed.expires_at,
            ],
          );
          await client.query(
            'INSERT INTO memory_revisions(tenant_id,memory_id,revision,content,value_json,change_reason) VALUES($1,$2,$3,$4,$5,$6)',
            [
              actor.tenant_id,
              id,
              result.rows[0].version,
              parsed.content,
              JSON.stringify(parsed.value),
              'explicit_update',
            ],
          );
          return {
            memory: publicMemory(result.rows[0]),
            memory_epoch: await epoch(client, actor),
          };
        },
      );
    },
    async deleteMemory(
      actor: ActorContext,
      id: string,
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `memory.delete:${id}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const row = await own(client, 'memories', actor, id, true);
          if (row.version !== expectedVersion)
            throw new AppError('VERSION_CONFLICT', '记忆已更新。');
          await client.query(
            "UPDATE memories SET status='deleted',deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1",
            [id],
          );
          await client.query(
            'INSERT INTO memory_source_tombstones(tenant_id,owner_id,source_key,reason) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,owner_id,source_key) DO UPDATE SET invalidated_at=now(),reason=$4',
            [
              actor.tenant_id,
              actor.user_id,
              `${row.kind}:${row.key}`,
              'user_deleted',
            ],
          );
          return { deleted: true, memory_epoch: await epoch(client, actor) };
        },
      );
    },
    async selectMemoryContext(actor: ActorContext, keys: string[]) {
      actor = await options.freshActor(actor);
      return transaction(database, async (client) => {
        const expired = await client.query(
          `UPDATE memories m SET status=CASE WHEN expires_at IS NOT NULL AND expires_at<=$3 THEN 'expired' ELSE 'source_unavailable' END,version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND owner_id=$2 AND status='active' AND ((expires_at IS NOT NULL AND expires_at<=$3) OR (source_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM messages msg JOIN threads t ON t.id=msg.thread_id WHERE msg.id=m.source_message_id AND t.deleted_at IS NULL))) RETURNING id`,
          [actor.tenant_id, actor.user_id, now()],
        );
        if (expired.rowCount) await epoch(client, actor);
        const result = await client.query(
          "SELECT * FROM memories WHERE tenant_id=$1 AND owner_id=$2 AND status='active' AND ($3::text[]='{}' OR key=ANY($3::text[])) ORDER BY updated_at DESC,id LIMIT 8",
          [actor.tenant_id, actor.user_id, keys],
        );
        const version = await client.query(
          'SELECT memory_epoch FROM memory_profiles WHERE tenant_id=$1 AND owner_id=$2',
          [actor.tenant_id, actor.user_id],
        );
        return {
          memory_epoch: Number(version.rows[0]?.memory_epoch ?? 0),
          authz_version: actor.authz_version,
          items: result.rows.map(publicMemory),
        };
      });
    },
    async restoreMemory(
      actor: ActorContext,
      id: string,
      input: { expected_version: number; revision_to_restore: number },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `memory.restore:${id}`,
        key,
        input,
        async (client) => {
          const old = await own(client, 'memories', actor, id, true);
          if (old.version !== input.expected_version)
            throw new AppError('VERSION_CONFLICT', '记忆已更新。');
          const revision = await client.query(
            'SELECT * FROM memory_revisions WHERE tenant_id=$1 AND memory_id=$2 AND revision=$3',
            [actor.tenant_id, id, input.revision_to_restore],
          );
          if (!revision.rows[0]?.content)
            throw new AppError('NOT_FOUND', '该版本内容已清理，不能恢复。');
          const source =
            old.source_kind === 'manual'
              ? { kind: 'manual' as const }
              : {
                  kind: 'explicit_message' as const,
                  message_id: old.source_message_id as string,
                };
          const memory = MemoryInputSchema.parse({
            kind: old.kind,
            key: old.key,
            content: revision.rows[0].content,
            value: revision.rows[0].value_json,
            expires_at: iso(old.expires_at),
            source,
            explicit_save: true,
          });
          assertMemoryContent(memory);
          if (memory.expires_at && new Date(memory.expires_at) <= now())
            throw new AppError(
              'VALIDATION_ERROR',
              '记忆已过期，请编辑后重新保存。',
            );
          await validateSource(client, actor, memory);
          const result = await client.query(
            "UPDATE memories SET content=$2,value_json=$3,status='active',deleted_at=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id, memory.content, JSON.stringify(memory.value)],
          );
          await client.query(
            'INSERT INTO memory_revisions(tenant_id,memory_id,revision,content,value_json,change_reason) VALUES($1,$2,$3,$4,$5,$6)',
            [
              actor.tenant_id,
              id,
              result.rows[0].version,
              memory.content,
              JSON.stringify(memory.value),
              'explicit_restore',
            ],
          );
          return {
            memory: publicMemory(result.rows[0]),
            memory_epoch: await epoch(client, actor),
          };
        },
      );
    },
    async createSubscription(actor: ActorContext, input: unknown, key: string) {
      actor = await options.freshActor(actor);
      const parsed = SubscriptionInputSchema.parse(input);
      const permissions = await validateSubscription(actor, parsed);
      const id = randomUUID();
      const schedulingNow = (await options.businessNow?.()) ?? now();
      const next = nextOccurrence(parsed.schedule, schedulingNow);
      return idempotent(
        database,
        actor,
        'subscription.create',
        key,
        parsed,
        async (client) => {
          const delegation = await options.createDelegation!(actor, {
            subscriptionId: id,
            allowedCapabilities: permissions,
          });
          const result = await client.query(
            "INSERT INTO subscriptions(id,tenant_id,owner_id,type,title,query_spec,schedule_json,status,next_run_at,skill_version_id,delegation_id,scope_authz_version) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11) RETURNING *",
            [
              id,
              actor.tenant_id,
              actor.user_id,
              parsed.type,
              parsed.title,
              JSON.stringify(parsed.query_spec),
              JSON.stringify(parsed.schedule),
              next.at,
              parsed.skill_version_id,
              delegation.id,
              actor.authz_version,
            ],
          );
          return {
            subscription: publicSubscription(result.rows[0]),
            next_occurrences: schedulePreview(parsed.schedule, schedulingNow),
          };
        },
      );
    },
    async listSubscriptions(actor: ActorContext) {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        "SELECT * FROM subscriptions WHERE tenant_id=$1 AND owner_id=$2 AND status<>'deleted' ORDER BY created_at DESC,id LIMIT 100",
        [actor.tenant_id, actor.user_id],
      );
      return { items: result.rows.map(publicSubscription), next_cursor: null };
    },
    async changeSubscription(
      actor: ActorContext,
      id: string,
      action: 'pause' | 'resume' | 'delete',
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const schedulingNow = (await options.businessNow?.()) ?? now();
      const current = await own(database.pool, 'subscriptions', actor, id);
      if (action === 'resume') {
        await validateSubscription(
          actor,
          SubscriptionInputSchema.parse({
            type: current.type,
            title: current.title,
            schedule: current.schedule_json,
            query_spec: current.query_spec,
            skill_version_id: current.skill_version_id,
            delivery: { channel: 'in_app' },
          }),
        );
        await delegated(current);
      }
      return idempotent(
        database,
        actor,
        `subscription.${action}:${id}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const row = await own(client, 'subscriptions', actor, id, true);
          if (row.version !== expectedVersion)
            throw new AppError('VERSION_CONFLICT', '日程已更新。');
          const status =
            action === 'pause'
              ? 'paused'
              : action === 'resume'
                ? 'active'
                : 'deleted';
          const result = await client.query(
            'UPDATE subscriptions SET status=$2,next_run_at=$3,version=version+1,updated_at=now(),error_code=NULL WHERE id=$1 RETURNING *',
            [
              id,
              status,
              action === 'resume'
                ? nextOccurrence(row.schedule_json, schedulingNow).at
                : row.next_run_at,
            ],
          );
          if (action !== 'resume') {
            await client.query(
              "UPDATE subscription_occurrences SET status='cancelled',version=version+1 WHERE tenant_id=$1 AND subscription_id=$2 AND status IN ('scheduled','generating','generated')",
              [actor.tenant_id, id],
            );
            await client.query(
              "UPDATE durable_jobs SET status='cancelled',lease_epoch=lease_epoch+1,lease_until=NULL WHERE tenant_id=$1 AND kind='digest.generate' AND payload_ref IN (SELECT id FROM subscription_occurrences WHERE tenant_id=$1 AND subscription_id=$2) AND status IN ('ready','running')",
              [actor.tenant_id, id],
            );
          }
          return publicSubscription(result.rows[0]);
        },
      );
    },
    async updateSubscription(
      actor: ActorContext,
      id: string,
      input: SubscriptionInput & { expected_version: number },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const schedulingNow = (await options.businessNow?.()) ?? now();
      const { expected_version, ...raw } = input;
      const parsed = SubscriptionInputSchema.parse(raw);
      const permissions = await validateSubscription(actor, parsed);
      return idempotent(
        database,
        actor,
        `subscription.update:${id}`,
        key,
        input,
        async (client) => {
          const old = await own(client, 'subscriptions', actor, id, true);
          if (old.version !== expected_version)
            throw new AppError('VERSION_CONFLICT', '日程已更新。');
          const delegation = await options.createDelegation!(actor, {
            subscriptionId: id,
            allowedCapabilities: permissions,
          });
          const result = await client.query(
            "UPDATE subscriptions SET type=$2,title=$3,query_spec=$4,schedule_json=$5,schedule_version=schedule_version+1,status='active',next_run_at=$6,skill_version_id=$7,delegation_id=$8,scope_authz_version=$9,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [
              id,
              parsed.type,
              parsed.title,
              JSON.stringify(parsed.query_spec),
              JSON.stringify(parsed.schedule),
              nextOccurrence(parsed.schedule, schedulingNow).at,
              parsed.skill_version_id,
              delegation.id,
              actor.authz_version,
            ],
          );
          await client.query(
            "UPDATE subscription_occurrences SET status='superseded',version=version+1 WHERE tenant_id=$1 AND subscription_id=$2 AND status IN ('scheduled','generating','generated')",
            [actor.tenant_id, id],
          );
          return {
            subscription: publicSubscription(result.rows[0]),
            next_occurrences: schedulePreview(parsed.schedule, schedulingNow),
          };
        },
      );
    },
    async occurrences(actor: ActorContext, id: string) {
      actor = await options.freshActor(actor);
      await own(database.pool, 'subscriptions', actor, id);
      const result = await database.pool.query(
        'SELECT id,version,scheduled_at,local_date,local_time,status,error_code,dst_adjusted FROM subscription_occurrences WHERE tenant_id=$1 AND owner_id=$2 AND subscription_id=$3 ORDER BY scheduled_at DESC,id LIMIT 100',
        [actor.tenant_id, actor.user_id, id],
      );
      return { items: result.rows, next_cursor: null };
    },
    async retryOccurrence(
      actor: ActorContext,
      id: string,
      occurrenceId: string,
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const subscription = await own(database.pool, 'subscriptions', actor, id);
      await delegated(subscription);
      return idempotent(
        database,
        actor,
        `digest.retry:${occurrenceId}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const result = await client.query(
            'SELECT * FROM subscription_occurrences WHERE tenant_id=$1 AND owner_id=$2 AND subscription_id=$3 AND id=$4 FOR UPDATE',
            [actor.tenant_id, actor.user_id, id, occurrenceId],
          );
          const occurrence = result.rows[0];
          if (!occurrence) throw new AppError('NOT_FOUND', '发生记录不存在。');
          if (occurrence.version !== expectedVersion)
            throw new AppError('VERSION_CONFLICT', '发生记录已更新。');
          if (
            subscription.status !== 'active' ||
            !['failed', 'delivery_expired'].includes(occurrence.status)
          )
            throw new AppError('INVALID_STATE', '该摘要当前不能重试。');
          if (
            now().getTime() - new Date(occurrence.created_at).getTime() >
            86400000
          )
            throw new AppError(
              'INVALID_STATE',
              '摘要已超过24小时，请重新查询当前数据。',
            );
          await client.query(
            "UPDATE subscription_occurrences SET status='scheduled',version=version+1,error_code=NULL WHERE id=$1",
            [occurrenceId],
          );
          await client.query(
            "UPDATE durable_jobs SET status='ready',attempt=0,ready_at=now(),lease_owner=NULL,lease_until=NULL,lease_epoch=lease_epoch+1 WHERE tenant_id=$1 AND kind='digest.generate' AND payload_ref=$2",
            [actor.tenant_id, occurrenceId],
          );
          return { occurrence_id: occurrenceId, status: 'scheduled' };
        },
      );
    },
    async scheduleDueSubscriptions(
      at = now(),
      batchSize = 30,
      scope: { tenantId?: string; subscriptionId?: string } = {},
    ) {
      return transaction(database, async (client) => {
        const due = await client.query(
          `SELECT s.* FROM subscriptions s WHERE s.status='active' AND s.next_run_at<=$1 AND ($3::text IS NULL OR s.tenant_id=$3) AND ($4::text IS NULL OR s.id=$4) AND ${currentDigestTenantSql('s.tenant_id')} ORDER BY s.next_run_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT $2`,
          [at, batchSize, scope.tenantId ?? null, scope.subscriptionId ?? null],
        );
        let enqueued = 0;
        for (const sub of due.rows) {
          let cursor = new Date(sub.next_run_at);
          const missed: Array<{
            at: Date;
            date: string;
            time: string;
            dst_adjusted: boolean;
          }> = [];
          let steps = 0;
          while (cursor <= at && steps++ < 400) {
            const local = localDateTime(cursor, sub.schedule_json.timezone);
            missed.push({
              at: cursor,
              date: local.date,
              time: sub.schedule_json.local_time,
              dst_adjusted: local.time !== sub.schedule_json.local_time,
            });
            cursor = nextOccurrence(sub.schedule_json, cursor).at;
          }
          const latest = missed.at(-1);
          for (const missedAt of missed) {
            const isLatest = latest === missedAt;
            const status = !isLatest
              ? 'skipped_coalesced'
              : at.getTime() - missedAt.at.getTime() > 21600000
                ? 'skipped_late'
                : 'scheduled';
            const id = randomUUID();
            const occurrence = await client.query(
              `INSERT INTO subscription_occurrences(id,tenant_id,owner_id,subscription_id,schedule_version,local_date,local_time,scheduled_at,status,dst_adjusted,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,subscription_id,schedule_version,local_date,local_time) DO NOTHING RETURNING id`,
              [
                id,
                sub.tenant_id,
                sub.owner_id,
                sub.id,
                sub.schedule_version,
                missedAt.date,
                missedAt.time,
                missedAt.at,
                status,
                missedAt.dst_adjusted,
                now(),
              ],
            );
            if (occurrence.rowCount && status === 'scheduled') {
              await client.query(
                `INSERT INTO durable_jobs(id,tenant_id,owner_module,kind,payload_ref,dedupe_key,generation) VALUES($1,$2,'memory','digest.generate',$3,$3,$4) ON CONFLICT(tenant_id,kind,dedupe_key) DO NOTHING`,
                [randomUUID(), sub.tenant_id, id, sub.generation],
              );
              enqueued++;
            }
          }
          await client.query(
            'UPDATE subscriptions SET next_run_at=$2,updated_at=now() WHERE id=$1',
            [
              sub.id,
              steps >= 400 ? nextOccurrence(sub.schedule_json, at).at : cursor,
            ],
          );
        }
        return { scanned: due.rowCount ?? 0, enqueued };
      });
    },
    async generateNextDigest(
      workerId: string,
      scope: { tenant_id?: string } = {},
    ) {
      const candidate = await database.pool.query(
        `SELECT j.tenant_id,j.payload_ref FROM durable_jobs j WHERE j.kind='digest.generate' AND j.ready_at<=now() AND ($1::text IS NULL OR j.tenant_id=$1) AND (j.status='ready' OR (j.status='running' AND j.lease_until<now())) AND ${currentDigestTenantSql('j.tenant_id')} ORDER BY j.ready_at,j.id LIMIT 1`,
        [scope.tenant_id ?? null],
      );
      if (!candidate.rows[0]) return false;
      const job = await queue.claim(workerId, ['digest.generate'], undefined, {
        tenant_id: candidate.rows[0].tenant_id,
        payload_ref: candidate.rows[0].payload_ref,
      });
      if (!job) return false;
      let sub: Row | undefined;
      try {
        const selected = await database.pool.query(
          'SELECT o.*,s.type,s.query_spec,s.delegation_id,s.skill_version_id,s.scope_authz_version,s.status AS subscription_status,s.schedule_version AS current_schedule_version FROM subscription_occurrences o JOIN subscriptions s ON s.id=o.subscription_id WHERE o.id=$1 AND o.tenant_id=$2',
          [job.payload_ref, job.tenant_id],
        );
        sub = selected.rows[0];
        if (
          !sub ||
          sub.subscription_status !== 'active' ||
          sub.schedule_version !== sub.current_schedule_version ||
          !['scheduled', 'generating', 'failed'].includes(sub.status)
        )
          throw new AppError('INVALID_STATE', '日程已暂停或版本已变化。');
        const actor = await delegated(sub);
        if (!options.readDigest)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '摘要数据服务尚未就绪。',
          );
        if (sub.skill_version_id) {
          if (!options.validateSkill)
            throw new AppError(
              'DEPENDENCY_UNAVAILABLE',
              'Skill 服务尚未就绪。',
            );
          const skill = await options.validateSkill(
            actor,
            sub.skill_version_id,
          );
          if (skill.tools.some((tool) => tool.effect !== 'read'))
            throw new AppError('FORBIDDEN', '后台摘要不能调用写入能力。');
        }
        const heartbeat = setInterval(() => {
          void queue
            .heartbeat(job.id, workerId, job.lease_epoch)
            .catch(() => {});
        }, 10000);
        let digest: DigestResult;
        try {
          digest = DigestResultSchema.parse({
            ...(await options.readDigest(actor, sub.type, sub.query_spec)),
            generated_at: now().toISOString(),
          });
        } finally {
          clearInterval(heartbeat);
        }
        const refreshed = await delegated(sub);
        if (refreshed.authz_version !== actor.authz_version)
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '摘要读取权限已变化，本次旧结果已停止发布。',
          );
        await transaction(database, async (client) => {
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [job.id, workerId, job.lease_epoch],
          );
          if (!fence.rowCount)
            throw new AppError('INVALID_STATE', '作业租约已失效。');
          const current = await client.query(
            "SELECT 1 FROM subscriptions s JOIN subscription_occurrences o ON o.subscription_id=s.id WHERE o.id=$1 AND s.status='active' AND s.schedule_version=o.schedule_version AND o.status IN ('scheduled','generating','failed') FOR UPDATE OF s,o",
            [job.payload_ref],
          );
          if (!current.rowCount)
            throw new AppError('INVALID_STATE', '日程已暂停或版本已变化。');
          const summaryId = randomUUID();
          const result = await client.query(
            `INSERT INTO digest_snapshots(id,tenant_id,owner_id,occurrence_id,query_spec,source_refs,coverage,generated_at,content_json,status,authz_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated',$10) ON CONFLICT(tenant_id,occurrence_id) DO UPDATE SET content_json=$9,source_refs=$6,coverage=$7,generated_at=$8,status='generated',authz_version=$10,version=digest_snapshots.version+1,updated_at=now() RETURNING id,version`,
            [
              summaryId,
              actor.tenant_id,
              actor.user_id,
              job.payload_ref,
              JSON.stringify(sub!.query_spec),
              JSON.stringify(digest.source_refs),
              digest.coverage,
              digest.generated_at,
              JSON.stringify(digest),
              actor.authz_version,
            ],
          );
          await client.query(
            "UPDATE subscription_occurrences SET status='generated',summary_id=$2,version=version+1 WHERE id=$1",
            [job.payload_ref, result.rows[0].id],
          );
          await outbox(
            client,
            actor,
            'digest.generated',
            result.rows[0].id,
            result.rows[0].version,
            { summary_id: result.rows[0].id, occurrence_id: job.payload_ref },
          );
          await client.query(
            "UPDATE durable_jobs SET status='succeeded',lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=$1 AND lease_epoch=$2",
            [job.id, job.lease_epoch],
          );
        });
        return true;
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
        await transaction(database, async (client) => {
          const fence = await client.query(
            "SELECT 1 FROM durable_jobs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE",
            [job.id, workerId, job.lease_epoch],
          );
          if (!fence.rowCount) return;
          const attempt = job.attempt;
          const within =
            sub &&
            now().getTime() - new Date(sub.created_at).getTime() < 21600000;
          const retry =
            within && attempt < 5 && code === 'DEPENDENCY_UNAVAILABLE';
          await client.query(
            'UPDATE durable_jobs SET status=$3,ready_at=$4,lease_until=NULL,lease_owner=NULL,error_code=$5 WHERE id=$1 AND lease_epoch=$2',
            [
              job.id,
              job.lease_epoch,
              retry ? 'ready' : 'failed',
              new Date(
                now().getTime() +
                  [60000, 300000, 900000, 3600000][Math.min(attempt - 1, 3)]!,
              ),
              code,
            ],
          );
          await client.query(
            "UPDATE subscription_occurrences SET status='failed',error_code=$2,version=version+1 WHERE id=$1 AND status NOT IN ('cancelled','superseded')",
            [job.payload_ref, code],
          );
          if (
            sub &&
            [
              'FORBIDDEN',
              'UNAUTHENTICATED',
              'NOT_FOUND',
              'REVALIDATION_REQUIRED',
            ].includes(code)
          )
            await client.query(
              "UPDATE subscriptions SET status='blocked',error_code='AUTHORIZATION_CHANGED',version=version+1 WHERE id=$1",
              [sub.subscription_id],
            );
          if (
            sub &&
            !retry &&
            code === 'DEPENDENCY_UNAVAILABLE' &&
            sub.subscription_status === 'active'
          ) {
            const digest = DigestResultSchema.parse({
              title: '今天的待办摘要暂未生成',
              preview: '摘要数据服务暂不可用，可查看执行记录后重试。',
              content: '本次摘要生成失败，未据此作出任何业务处理。请稍后重试。',
              source_refs: [],
              coverage: 'unavailable',
              generated_at: now().toISOString(),
            });
            const summary = await client.query(
              `INSERT INTO digest_snapshots(id,tenant_id,owner_id,occurrence_id,query_spec,source_refs,coverage,generated_at,content_json,status,authz_version) VALUES($1,$2,$3,$4,$5,'[]','unavailable',$6,$7,'failed',$8) ON CONFLICT(tenant_id,occurrence_id) DO UPDATE SET content_json=$7,coverage='unavailable',generated_at=$6,status='failed',version=digest_snapshots.version+1 RETURNING id,version`,
              [
                randomUUID(),
                sub.tenant_id,
                sub.owner_id,
                job.payload_ref,
                JSON.stringify(sub.query_spec),
                digest.generated_at,
                JSON.stringify(digest),
                sub.scope_authz_version ?? 1,
              ],
            );
            await client.query(
              'UPDATE subscription_occurrences SET summary_id=$2 WHERE id=$1',
              [job.payload_ref, summary.rows[0].id],
            );
            await outbox(
              client,
              { tenant_id: sub.tenant_id },
              'digest.generated',
              summary.rows[0].id,
              summary.rows[0].version,
              {
                summary_id: summary.rows[0].id,
                occurrence_id: job.payload_ref,
              },
            );
          }
        });
        return true;
      }
    },
    async deliverInbox(outboxId: string) {
      const selected = await database.pool.query(
        `SELECT e.*,d.owner_id,d.occurrence_id,d.content_json,d.generated_at,d.version AS snapshot_version,d.status AS digest_status,o.subscription_id,s.delegation_id,s.status AS subscription_status,s.schedule_version AS current_schedule_version,o.schedule_version FROM outbox_events e JOIN digest_snapshots d ON d.tenant_id=e.tenant_id AND d.id=e.resource_id JOIN subscription_occurrences o ON o.tenant_id=d.tenant_id AND o.id=d.occurrence_id JOIN subscriptions s ON s.tenant_id=o.tenant_id AND s.id=o.subscription_id WHERE e.id=$1 AND e.event_type='digest.generated' AND ${currentDigestTenantSql('e.tenant_id')}`,
        [outboxId],
      );
      const row = selected.rows[0];
      if (!row) throw new AppError('NOT_FOUND', '投递任务不存在。');
      if (
        row.subscription_status !== 'active' ||
        row.schedule_version !== row.current_schedule_version
      )
        return { item_id: null, created: false };
      const actor = await delegated(row);
      const digest = DigestResultSchema.parse(row.content_json);
      for (const ref of digest.source_refs) {
        if (!options.authorizeResource)
          throw new AppError('NOT_FOUND', '摘要已不可查看。');
        await options.authorizeResource(actor, ref);
      }
      return transaction(database, async (client) => {
        const current = await client.query(
          'SELECT s.status,o.status AS occurrence_status,s.schedule_version,o.schedule_version AS occurrence_version FROM subscriptions s JOIN subscription_occurrences o ON o.subscription_id=s.id WHERE o.id=$1 FOR UPDATE OF s,o',
          [row.occurrence_id],
        );
        if (
          current.rows[0]?.status !== 'active' ||
          current.rows[0]?.schedule_version !==
            current.rows[0]?.occurrence_version ||
          ['cancelled', 'superseded'].includes(
            current.rows[0]?.occurrence_status,
          )
        )
          return { item_id: null, created: false };
        if (now().getTime() - new Date(row.generated_at).getTime() > 86400000) {
          await client.query(
            "UPDATE subscription_occurrences SET status='delivery_expired' WHERE id=$1",
            [row.occurrence_id],
          );
          return { item_id: null, created: false };
        }
        const existing = await client.query(
          'SELECT * FROM inbox_items WHERE tenant_id=$1 AND occurrence_id=$2 AND channel=$3',
          [actor.tenant_id, row.occurrence_id, 'in_app'],
        );
        if (existing.rows[0]) {
          if (row.snapshot_version > existing.rows[0].revision)
            await client.query(
              'UPDATE inbox_items SET title=$2,preview=$3,revision=$4,version=version+1,updated_at=now() WHERE id=$1',
              [
                existing.rows[0].id,
                digest.title,
                digest.preview,
                row.snapshot_version,
              ],
            );
          await client.query(
            'UPDATE subscription_occurrences SET status=$2,version=version+1 WHERE id=$1',
            [
              row.occurrence_id,
              row.digest_status === 'failed' ? 'failed' : 'delivered',
            ],
          );
          await client.query(
            'UPDATE outbox_events SET published_at=COALESCE(published_at,now()) WHERE id=$1',
            [outboxId],
          );
          return { item_id: existing.rows[0].id as string, created: false };
        }
        const id = randomUUID();
        await client.query(
          'INSERT INTO inbox_items(id,tenant_id,owner_id,occurrence_id,title,preview,summary_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            id,
            actor.tenant_id,
            actor.user_id,
            row.occurrence_id,
            digest.title,
            digest.preview,
            row.resource_id,
            row.snapshot_version,
          ],
        );
        await client.query(
          'UPDATE subscription_occurrences SET status=$2,version=version+1 WHERE id=$1',
          [
            row.occurrence_id,
            row.digest_status === 'failed' ? 'failed' : 'delivered',
          ],
        );
        await client.query(
          'UPDATE outbox_events SET published_at=now() WHERE id=$1',
          [outboxId],
        );
        return { item_id: id, created: true };
      });
    },
    async deliverPending(limit = 30, scope: { tenant_id?: string } = {}) {
      const result = await database.pool.query(
        `SELECT e.id FROM outbox_events e WHERE e.event_type='digest.generated' AND e.published_at IS NULL AND ($2::text IS NULL OR e.tenant_id=$2) AND ${currentDigestTenantSql('e.tenant_id')} ORDER BY e.created_at,e.id LIMIT $1`,
        [limit, scope.tenant_id ?? null],
      );
      let delivered = 0;
      for (const row of result.rows) {
        try {
          const outcome = await service.deliverInbox(row.id);
          if (outcome.created) delivered++;
        } catch {}
      }
      return { delivered };
    },
    async listInbox(actor: ActorContext) {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        'SELECT i.*,COALESCE(r.read_revision,0) read_revision FROM inbox_items i LEFT JOIN inbox_reads r ON r.tenant_id=i.tenant_id AND r.owner_id=i.owner_id AND r.item_id=i.id WHERE i.tenant_id=$1 AND i.owner_id=$2 AND i.deleted_at IS NULL ORDER BY i.created_at DESC,i.id LIMIT 100',
        [actor.tenant_id, actor.user_id],
      );
      const items = [];
      for (const row of result.rows) {
        try {
          await visibleDigest(actor, row);
          items.push({
            id: row.id,
            version: row.version,
            title: row.title,
            preview: row.preview,
            revision: row.revision,
            read_revision: row.read_revision,
            unread: row.revision > row.read_revision,
            created_at: iso(row.created_at),
            thread_id: row.thread_id,
          });
        } catch {
          items.push({
            id: row.id,
            version: row.version,
            title: '此摘要暂不可查看',
            preview: '数据权限已变化。',
            revision: row.revision,
            read_revision: row.read_revision,
            unread: false,
            created_at: iso(row.created_at),
            thread_id: null,
          });
        }
      }
      return { items, next_cursor: null };
    },
    async unreadCount(actor: ActorContext) {
      const inbox = await service.listInbox(actor);
      return inbox.items.filter((item) => item.unread).length;
    },
    async markRead(
      actor: ActorContext,
      id: string,
      input: { expected_version: number; read_revision: number },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `inbox.read:${id}`,
        key,
        input,
        async (client) => {
          const row = await own(client, 'inbox_items', actor, id, true);
          if (
            row.version !== input.expected_version ||
            row.revision !== input.read_revision
          )
            throw new AppError(
              'VERSION_CONFLICT',
              '摘要已更新，请读取最新内容。',
            );
          await visibleDigest(actor, row);
          await client.query(
            'INSERT INTO inbox_reads(tenant_id,owner_id,item_id,read_revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,owner_id,item_id) DO UPDATE SET read_revision=GREATEST(inbox_reads.read_revision,$4),read_at=now()',
            [actor.tenant_id, actor.user_id, id, input.read_revision],
          );
          return { read_revision: input.read_revision };
        },
      );
    },
    async openInbox(
      actor: ActorContext,
      id: string,
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `inbox.open:${id}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const item = await own(client, 'inbox_items', actor, id, true);
          if (item.version !== expectedVersion)
            throw new AppError('VERSION_CONFLICT', '摘要已更新。');
          const snapshot = await visibleDigest(actor, item);
          const digest = DigestResultSchema.parse(snapshot.content_json);
          if (item.thread_id) {
            const old = await client.query(
              'SELECT id FROM threads WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND deleted_at IS NULL',
              [actor.tenant_id, actor.user_id, item.thread_id],
            );
            if (old.rowCount) {
              const previous = await client.query(
                'SELECT card FROM cards WHERE tenant_id=$1 AND id=$2',
                [actor.tenant_id, item.card_id],
              );
              if (
                previous.rows[0] &&
                (previous.rows[0].card.snapshot_at !== digest.generated_at ||
                  previous.rows[0].card.revision < item.revision)
              ) {
                const before = previous.rows[0].card;
                const card = AgentCardSchema.parse({
                  ...before,
                  title: digest.title,
                  summary: digest.preview,
                  snapshot_at: digest.generated_at,
                  resource_refs: digest.source_refs,
                  payload: {
                    ...before.payload,
                    generated_at: digest.generated_at,
                    subject_refs: digest.source_refs,
                  },
                  revision: before.revision + 1,
                });
                await client.query(
                  'UPDATE cards SET card=$3,revision=$4,version=version+1,snapshot_at=$5,authz_version=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2',
                  [
                    actor.tenant_id,
                    item.card_id,
                    JSON.stringify(card),
                    card.revision,
                    digest.generated_at,
                    actor.authz_version,
                  ],
                );
                await client.query(
                  "UPDATE messages SET content=$3,resource_refs=$4,authz_version=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND role='assistant' AND run_id IS NULL",
                  [
                    actor.tenant_id,
                    card.message_id,
                    digest.content,
                    JSON.stringify(digest.source_refs),
                    actor.authz_version,
                  ],
                );
              }
              return {
                thread_id: item.thread_id,
                card_id: item.card_id,
                reused: true,
              };
            }
          }
          const threadId = randomUUID(),
            messageId = randomUUID(),
            cardId = randomUUID();
          await client.query(
            'INSERT INTO threads(id,tenant_id,owner_id,title,last_message_seq) VALUES($1,$2,$3,$4,1)',
            [threadId, actor.tenant_id, actor.user_id, digest.title],
          );
          await client.query(
            "INSERT INTO messages(id,tenant_id,owner_id,thread_id,seq,role,content,status,resource_refs,authz_version) VALUES($1,$2,$3,$4,1,'assistant',$5,'final',$6,$7)",
            [
              messageId,
              actor.tenant_id,
              actor.user_id,
              threadId,
              digest.content,
              JSON.stringify(digest.source_refs),
              actor.authz_version,
            ],
          );
          const card = AgentCardSchema.parse({
            id: cardId,
            schema_version: 1,
            type: 'reminder_summary',
            thread_id: threadId,
            message_id: messageId,
            run_id: null,
            title: digest.title,
            summary: digest.preview,
            snapshot_at: digest.generated_at,
            resource_refs: digest.source_refs,
            payload: {
              inbox_item_id: id,
              generated_at: digest.generated_at,
              subject_refs: digest.source_refs,
              read_only: true,
              origin_run_id: null,
              occurrence_id: item.occurrence_id,
            },
            actions: [
              {
                id: 'view',
                label: '查看摘要',
                kind: 'open_drawer',
                target: `drawer:reminder:${id}`,
              },
            ],
            revision: 1,
            stale: false,
          });
          await client.query(
            'INSERT INTO cards(id,tenant_id,owner_id,thread_id,message_id,type,card,revision,snapshot_at,authz_version) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9)',
            [
              cardId,
              actor.tenant_id,
              actor.user_id,
              threadId,
              messageId,
              'reminder_summary',
              JSON.stringify(card),
              digest.generated_at,
              actor.authz_version,
            ],
          );
          await client.query(
            'UPDATE inbox_items SET thread_id=$2,card_id=$3,updated_at=now() WHERE id=$1',
            [id, threadId, cardId],
          );
          return { thread_id: threadId, card_id: cardId, reused: false };
        },
      );
    },
    async deleteInbox(
      actor: ActorContext,
      id: string,
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `inbox.delete:${id}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const row = await own(client, 'inbox_items', actor, id, true);
          if (row.version !== expectedVersion)
            throw new AppError('VERSION_CONFLICT', '摘要已更新。');
          await client.query(
            'UPDATE inbox_items SET deleted_at=now(),version=version+1 WHERE id=$1',
            [id],
          );
          return { deleted: true };
        },
      );
    },
    async cleanup() {
      await transaction(database, async (client) => {
        await client.query(
          "UPDATE memories SET content=NULL,value_json=NULL WHERE status IN ('deleted','expired') AND updated_at<now()-interval '30 days'",
        );
        await client.query(
          "UPDATE memory_revisions SET content=NULL,value_json=NULL WHERE memory_id IN (SELECT id FROM memories WHERE status IN ('deleted','expired') AND updated_at<now()-interval '30 days')",
        );
      });
    },
  };
  return service;
}
export type MemoryService = ReturnType<typeof createMemoryService>;
