import { createHash, randomUUID } from 'node:crypto';
import type {
  ActorContext,
  RunStatus,
  SseEvent,
  SseEventType,
  ToolResult,
} from '@caixiaozhi/contracts';
import {
  CheckpointSchema,
  RunBudgetsSchema,
  RunSchema,
  type CreateRunInput,
  type Run,
  type RunBudgets,
  type RunCheckpoint,
} from '@caixiaozhi/contracts/runs';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { PoolClient } from 'pg';
import { createModelSlotService } from './model-slots.js';

type Client = PoolClient;
type Row = Record<string, any>;
export type FreshActor = (actor: ActorContext) => Promise<ActorContext>;
export type LeasedRun = {
  run: Run;
  actor: ActorContext;
  lease_epoch: number;
  worker_id: string;
  checkpoint: RunCheckpoint | null;
  resume_input: unknown;
};
export type RunServiceOptions = {
  freshActor: FreshActor;
  authorizeThread?: (
    actor: ActorContext,
    threadId: string,
    inputMessageId: string,
  ) => Promise<void>;
  authorizeResume?: (
    actor: ActorContext,
    run: Run,
    checkpoint: RunCheckpoint,
  ) => Promise<void>;
  budgets?: Partial<RunBudgets>;
  leaseMs?: number;
  userSlots?: number;
  tenantSlots?: number;
};
const terminal = (status: string) =>
  ['succeeded', 'failed', 'cancelled'].includes(status);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Row)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const runPayloadHash = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const instant = (value: unknown) =>
  value instanceof Date
    ? value.toISOString()
    : value === null
      ? null
      : String(value);
const eventDto = (row: Row): SseEvent => ({
  run_id: String(row.run_id),
  seq: Number(row.seq),
  type: row.type,
  payload: row.payload,
  occurred_at: String(instant(row.occurred_at)),
});
function dto(row: Row): Run {
  const fields = {
    ...row,
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
    started_at: instant(row.started_at),
    finished_at: instant(row.finished_at),
    cancel_requested_at: instant(row.cancel_requested_at),
    last_seq: Number(row.last_seq),
  };
  return RunSchema.parse(
    Object.fromEntries(
      Object.keys(RunSchema.shape).map((key) => [
        key,
        fields[key as keyof typeof fields],
      ]),
    ),
  );
}

export function createRunService(
  database: DatabaseConnection,
  options: RunServiceOptions,
) {
  const budgets = RunBudgetsSchema.parse(options.budgets ?? {});
  const leaseMs = options.leaseMs ?? 30000;
  let eventSink:
    ((client: PoolClient, event: SseEvent) => Promise<void>) | undefined;
  let completionGuard:
    ((client: PoolClient, runId: string) => Promise<boolean>) | undefined;
  async function tx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function owned(
    client: Pick<Client, 'query'>,
    actor: ActorContext,
    id: string,
    lock = false,
  ): Promise<Row> {
    const result = await client.query(
      `SELECT * FROM agent_runs WHERE id=$1 AND tenant_id=$2 AND owner_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [id, actor.tenant_id, actor.user_id],
    );
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '任务不存在。');
    return result.rows[0];
  }
  async function event(
    client: Client,
    runId: string,
    type: SseEventType,
    payload: unknown,
  ): Promise<SseEvent> {
    const { rows } = await client.query(
      'UPDATE agent_runs SET last_seq=last_seq+1 WHERE id=$1 RETURNING last_seq,authz_version',
      [runId],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', '任务不存在。');
    const result = await client.query(
      'INSERT INTO run_events(run_id,seq,type,payload,authz_version) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [
        runId,
        rows[0].last_seq,
        type,
        JSON.stringify(payload),
        rows[0].authz_version,
      ],
    );
    const row = result.rows[0];
    const saved = eventDto(row);
    await eventSink?.(client, saved);
    return saved;
  }
  async function audit(
    client: Client,
    run: Row,
    actorId: string,
    operation: string,
    reason: string | null = null,
  ) {
    await client.query(
      'INSERT INTO run_audit(id,tenant_id,run_id,actor_id,operation,reason,trace_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        randomUUID(),
        run.tenant_id,
        run.id,
        actorId,
        operation,
        reason,
        run.trace_id,
      ],
    );
  }
  async function transition(
    client: Client,
    id: string,
    status: RunStatus,
    extras: {
      phase?: string | null;
      error_code?: string | null;
      runtime_active?: boolean;
    } = {},
  ) {
    const { rows } = await client.query(
      `UPDATE agent_runs SET status=$2,version=version+1,updated_at=now(),phase=$3,error_code=$4,
      runtime_active=$5,finished_at=CASE WHEN $6 THEN now() ELSE finished_at END WHERE id=$1 RETURNING *`,
      [
        id,
        status,
        extras.phase ?? null,
        extras.error_code ?? null,
        extras.runtime_active ?? false,
        terminal(status),
      ],
    );
    const row = rows[0]!;
    await event(client, id, 'run.status', {
      status,
      version: row.version,
      phase: row.phase,
      runtime_active: row.runtime_active,
    });
    if (
      terminal(status) ||
      status.startsWith('waiting') ||
      status === 'interrupted' ||
      status === 'reconciling'
    ) {
      await client.query('DELETE FROM run_jobs WHERE run_id=$1', [id]);
      await client.query(
        'UPDATE run_leases SET lease_until=now() WHERE run_id=$1',
        [id],
      );
    }
    return row;
  }
  async function lockedLease(
    client: Client,
    id: string,
    epoch: number,
    allowCancel = false,
  ): Promise<Row> {
    const result = await client.query(
      `SELECT r.*,l.lease_epoch FROM agent_runs r JOIN run_leases l ON l.run_id=r.id
      WHERE r.id=$1 AND l.lease_epoch=$2 AND l.lease_until>clock_timestamp() AND r.status='running' AND r.runtime_active
      ${allowCancel ? '' : 'AND r.cancel_requested_at IS NULL'} FOR UPDATE OF r,l`,
      [id, epoch],
    );
    if (!result.rows[0])
      throw new AppError('INVALID_STATE', '任务租约已失效，已停止后续步骤。', {
        details: { reason: 'LEASE_LOST' },
      });
    return result.rows[0];
  }
  async function previous(
    client: Client,
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
  ): Promise<Row | null> {
    if (!key || key.length > 200)
      throw new AppError('VALIDATION_ERROR', '请提供有效的 Idempotency-Key。');
    const result = await client.query(
      'SELECT payload_hash,run_id FROM run_commands WHERE tenant_id=$1 AND actor_id=$2 AND operation=$3 AND idempotency_key=$4',
      [actor.tenant_id, actor.user_id, operation, key],
    );
    if (!result.rows[0]) return null;
    if (result.rows[0].payload_hash !== runPayloadHash(input))
      throw new AppError('IDEMPOTENCY_CONFLICT', '该请求标识已用于不同内容。');
    return owned(client, actor, result.rows[0].run_id);
  }
  async function command(
    client: Client,
    actor: ActorContext,
    operation: string,
    key: string,
    input: unknown,
    id: string,
  ) {
    await client.query(
      'INSERT INTO run_commands(tenant_id,actor_id,operation,idempotency_key,payload_hash,run_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        actor.tenant_id,
        actor.user_id,
        operation,
        key,
        runPayloadHash(input),
        id,
      ],
    );
  }
  async function lockOwner(client: Client, actor: ActorContext) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `run:${actor.tenant_id}:${actor.user_id}`,
    ]);
  }
  const service = {
    modelSlots: createModelSlotService(database),
    setEventSink(sink: (client: PoolClient, event: SseEvent) => Promise<void>) {
      eventSink = sink;
    },
    setCompletionGuard(
      guard: (client: PoolClient, runId: string) => Promise<boolean>,
    ) {
      completionGuard = guard;
    },
    async createRun(
      actor: ActorContext,
      input: CreateRunInput,
      key: string,
      trustedTransaction?: { client: PoolClient; threadAuthorized: true },
    ): Promise<Run> {
      actor = await options.freshActor(actor);
      if (actor.invocation_origin !== 'interactive')
        throw new AppError('FORBIDDEN', '交互任务需要有效会话。');
      if (!trustedTransaction)
        await options.authorizeThread?.(
          actor,
          input.thread_id,
          input.input_message_id,
        );
      const work = async (client: Client) => {
        await lockOwner(client, actor);
        const old = await previous(client, actor, 'run.create', key, input);
        if (old) return dto(old);
        const existing = await client.query(
          'SELECT * FROM agent_runs WHERE tenant_id=$1 AND input_message_id=$2',
          [actor.tenant_id, input.input_message_id],
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].owner_id !== actor.user_id ||
            existing.rows[0].thread_id !== input.thread_id ||
            existing.rows[0].selected_skill_version_id !==
              (input.selected_skill_version_id ?? null)
          )
            throw new AppError(
              'IDEMPOTENCY_CONFLICT',
              '该消息已绑定其他任务。',
            );
          await command(
            client,
            actor,
            'run.create',
            key,
            input,
            existing.rows[0].id,
          );
          return dto(existing.rows[0]);
        }
        const active = await client.query(
          `SELECT id FROM agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND status NOT IN ('succeeded','failed','cancelled')`,
          [actor.tenant_id, input.thread_id],
        );
        if (active.rowCount)
          throw new AppError(
            'INVALID_STATE',
            '此会话已有未结束任务，请续接或停止该任务。',
          );
        await service.assertCapacity(client, actor);
        const id = randomUUID();
        const { rows } = await client.query(
          `INSERT INTO agent_runs(id,tenant_id,owner_id,origin,thread_id,input_message_id,status,selected_skill_version_id,authz_version,actor_context,trace_id,budgets)
          VALUES($1,$2,$3,'conversation',$4,$5,'queued',$6,$7,$8,$9,$10) RETURNING *`,
          [
            id,
            actor.tenant_id,
            actor.user_id,
            input.thread_id,
            input.input_message_id,
            input.selected_skill_version_id ?? null,
            actor.authz_version,
            JSON.stringify(actor),
            randomUUID(),
            JSON.stringify(budgets),
          ],
        );
        await client.query('INSERT INTO run_jobs(run_id) VALUES($1)', [id]);
        await command(client, actor, 'run.create', key, input, id);
        await event(client, id, 'run.status', {
          status: 'queued',
          version: 1,
          phase: null,
          runtime_active: false,
        });
        await client.query(
          `INSERT INTO outbox_events(id,tenant_id,event_type,schema_version,resource_type,resource_id,resource_version,occurred_at,payload)
          VALUES($1,$2,'run.queued',1,'run',$3,1,now(),$4)`,
          [randomUUID(), actor.tenant_id, id, JSON.stringify({ run_id: id })],
        );
        await audit(client, rows[0], actor.user_id, 'run.create');
        return dto({ ...rows[0], last_seq: 1 });
      };
      return trustedTransaction ? work(trustedTransaction.client) : tx(work);
    },
    async assertCapacity(client: Pick<Client, 'query'>, actor: ActorContext) {
      const count = await client.query(
        `SELECT count(*)::int AS n FROM agent_runs WHERE tenant_id=$1 AND owner_id=$2 AND status NOT IN ('succeeded','failed','cancelled')`,
        [actor.tenant_id, actor.user_id],
      );
      if (count.rows[0].n >= 10)
        throw new AppError(
          'RATE_LIMITED',
          '未结束任务已达 10 个，请先完成或取消已有任务。',
          { retryable: true },
        );
    },
    async enqueueSubscription(
      actor: ActorContext,
      input: {
        occurrence_id: string;
        selected_skill_version_id?: string;
        parent_run_id?: string;
      },
    ): Promise<Run> {
      actor = await options.freshActor(actor);
      if (actor.invocation_origin !== 'subscription')
        throw new AppError('FORBIDDEN', '后台任务需要有效订阅授权。');
      return tx(async (client) => {
        await lockOwner(client, actor);
        const old = await client.query(
          `SELECT * FROM agent_runs WHERE tenant_id=$1 AND occurrence_id=$2 ORDER BY created_at DESC LIMIT 1`,
          [actor.tenant_id, input.occurrence_id],
        );
        if (old.rows[0]) {
          if (old.rows[0].owner_id !== actor.user_id)
            throw new AppError('NOT_FOUND', '任务不存在。');
          return dto(old.rows[0]);
        }
        await service.assertCapacity(client, actor);
        const { rows } = await client.query(
          `INSERT INTO agent_runs(id,tenant_id,owner_id,origin,occurrence_id,status,selected_skill_version_id,authz_version,actor_context,trace_id,budgets,parent_run_id)
          VALUES($1,$2,$3,'subscription',$4,'queued',$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            randomUUID(),
            actor.tenant_id,
            actor.user_id,
            input.occurrence_id,
            input.selected_skill_version_id ?? null,
            actor.authz_version,
            JSON.stringify(actor),
            randomUUID(),
            JSON.stringify(budgets),
            input.parent_run_id ?? null,
          ],
        );
        await client.query('INSERT INTO run_jobs(run_id) VALUES($1)', [
          rows[0].id,
        ]);
        await event(client, rows[0].id, 'run.status', {
          status: 'queued',
          runtime_active: false,
          version: 1,
        });
        return dto({ ...rows[0], last_seq: 1 });
      });
    },
    async getRun(actor: ActorContext, id: string): Promise<Run> {
      actor = await options.freshActor(actor);
      return dto(await owned(database.pool, actor, id));
    },
    async listRuns(actor: ActorContext): Promise<Run[]> {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        'SELECT * FROM agent_runs WHERE tenant_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',
        [actor.tenant_id, actor.user_id],
      );
      return result.rows.map(dto);
    },
    async events(
      actor: ActorContext,
      id: string,
      after = 0,
      limit = 100,
    ): Promise<SseEvent[]> {
      actor = await options.freshActor(actor);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new AppError('VALIDATION_ERROR', '事件游标无效。');
      const run = await owned(database.pool, actor, id);
      const revalidation = () =>
        new AppError(
          'REVALIDATION_REQUIRED',
          '任务的权限上下文已变化，请读取当前授权快照。',
          {
            details: {
              reason: 'PERMISSION_CONTEXT_CHANGED',
              recovery: 'read_snapshot',
              latest_seq: Number(run.last_seq),
              snapshot_url: run.thread_id
                ? `/api/v1/threads/${run.thread_id}/snapshot`
                : `/api/v1/runs/${id}/snapshot`,
            },
          },
        );
      if (run.authz_version !== actor.authz_version) throw revalidation();
      if (after < Number(run.event_floor) - 1)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '事件已过期，请先刷新任务快照。',
          {
            details: {
              reason: 'EVENT_CURSOR_EXPIRED',
              recovery: 'read_snapshot',
              latest_seq: Number(run.last_seq),
              snapshot_url: `/api/v1/runs/${id}/snapshot`,
            },
          },
        );
      if (after > Number(run.last_seq))
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '事件游标超出当前任务范围。',
          {
            details: {
              reason: 'EVENT_CURSOR_AHEAD',
              latest_seq: Number(run.last_seq),
            },
          },
        );
      const result = await database.pool.query(
        'SELECT * FROM run_events WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3',
        [id, after, Math.max(1, Math.min(100, limit))],
      );
      if (result.rows.some((row) => row.authz_version !== actor.authz_version))
        throw revalidation();
      return result.rows.map(eventDto);
    },
    async snapshot(actor: ActorContext, id: string) {
      actor = await options.freshActor(actor);
      const run = await service.getRun(actor, id);
      const events = await database.pool.query(
        `SELECT DISTINCT ON(type,COALESCE(payload->>'id','')) * FROM run_events
        WHERE run_id=$1 AND type IN ('assistant.message','card.upsert','confirmation.required') ORDER BY type,COALESCE(payload->>'id',''),seq DESC`,
        [id],
      );
      return {
        run,
        latest_seq: run.last_seq,
        events: events.rows
          .filter((row) => row.authz_version === actor.authz_version)
          .map(eventDto),
      };
    },
    async resumeRun(
      actor: ActorContext,
      id: string,
      input: {
        expected_version: number;
        checkpoint_id: string;
        input?: unknown;
      },
      key: string,
      trustedTransaction?: { client: PoolClient },
    ): Promise<Run> {
      actor = await options.freshActor(actor);
      const work = async (client: Client) => {
        await lockOwner(client, actor);
        const old = await previous(
          client,
          actor,
          `run.resume:${id}`,
          key,
          input,
        );
        if (old) return dto(old);
        const row = await owned(client, actor, id, true);
        if (row.version !== input.expected_version)
          throw new AppError('VERSION_CONFLICT', '任务已更新，请刷新。', {
            details: { current_version: row.version },
          });
        if (
          !['waiting_user', 'waiting_confirmation', 'interrupted'].includes(
            row.status,
          ) ||
          row.cancel_requested_at
        )
          throw new AppError('INVALID_STATE', '此任务当前不能续接。');
        if (row.checkpoint_id !== input.checkpoint_id)
          throw new AppError('VERSION_CONFLICT', '检查点已变更，请刷新任务。');
        const point = await client.query(
          'SELECT checkpoint FROM run_checkpoints WHERE id=$1 AND run_id=$2',
          [input.checkpoint_id, id],
        );
        const checkpoint = CheckpointSchema.parse(point.rows[0]?.checkpoint);
        if (
          checkpoint.stage === 'waiting_confirmation' &&
          !options.authorizeResume
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '需要先核实确认操作的服务端结果。',
          );
        await options.authorizeResume?.(actor, dto(row), checkpoint);
        await client.query(
          'UPDATE run_checkpoints SET resume_input=$2,resumed_at=now() WHERE id=$1',
          [input.checkpoint_id, JSON.stringify(input.input ?? null)],
        );
        await client.query(
          'UPDATE agent_runs SET actor_context=$2,authz_version=$3 WHERE id=$1',
          [id, JSON.stringify(actor), actor.authz_version],
        );
        const next = await transition(client, id, 'queued');
        await client.query(
          'INSERT INTO run_jobs(run_id) VALUES($1) ON CONFLICT(run_id) DO UPDATE SET ready_at=now()',
          [id],
        );
        await command(client, actor, `run.resume:${id}`, key, input, id);
        await audit(client, row, actor.user_id, 'run.resume');
        return dto({ ...next, last_seq: Number(next.last_seq) + 1 });
      };
      return trustedTransaction ? work(trustedTransaction.client) : tx(work);
    },
    async cancelRun(
      actor: ActorContext,
      id: string,
      input: { expected_version: number; reason: string },
      key: string,
    ): Promise<Run> {
      actor = await options.freshActor(actor);
      return tx(async (client) => {
        await lockOwner(client, actor);
        const old = await previous(
          client,
          actor,
          `run.cancel:${id}`,
          key,
          input,
        );
        if (old) return dto(old);
        const row = await owned(client, actor, id, true);
        if (row.version !== input.expected_version)
          throw new AppError('VERSION_CONFLICT', '任务已更新，请刷新。', {
            details: { current_version: row.version },
          });
        if (terminal(row.status))
          throw new AppError('INVALID_STATE', '任务已结束。');
        await client.query(
          'UPDATE agent_runs SET cancel_requested_at=now(),version=version+1,updated_at=now() WHERE id=$1',
          [id],
        );
        const pending = await client.query(
          `SELECT 1 FROM runtime_tool_calls WHERE run_id=$1 AND effect='write' AND status IN ('running','unknown') LIMIT 1`,
          [id],
        );
        let next: Row;
        if (pending.rowCount)
          next = await transition(client, id, 'reconciling', {
            phase: 'cancel_pending_receipts',
          });
        else if (!row.runtime_active)
          next = await transition(client, id, 'cancelled');
        else {
          next = (
            await client.query('SELECT * FROM agent_runs WHERE id=$1', [id])
          ).rows[0];
          await event(client, id, 'run.status', {
            status: row.status,
            version: next.version,
            phase: 'cancelling',
            runtime_active: true,
          });
        }
        await command(client, actor, `run.cancel:${id}`, key, input, id);
        await audit(client, row, actor.user_id, 'run.cancel', input.reason);
        return dto({ ...next, last_seq: Number(next.last_seq) + 1 });
      });
    },
    async claimRun(
      workerId: string,
      scope: { tenant_id?: string } = {},
    ): Promise<LeasedRun | null> {
      return tx(async (client) => {
        // 全局短事务锁只保护配额与公平选择，不持有网络/模型调用。
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('runtime:claim',0))",
        );
        const result = await client.query(
          `SELECT r.* FROM agent_runs r JOIN run_jobs j ON j.run_id=r.id
          LEFT JOIN runtime_fairness f ON f.tenant_id=r.tenant_id AND f.owner_id=r.owner_id
          WHERE r.status='queued' AND r.cancel_requested_at IS NULL AND j.ready_at<=now()
          AND ($3::text IS NULL OR r.tenant_id=$3)
          AND (SELECT count(*) FROM agent_runs a JOIN run_leases l ON l.run_id=a.id WHERE a.tenant_id=r.tenant_id AND a.runtime_active AND l.lease_until>clock_timestamp())<$1
          AND (SELECT count(*) FROM agent_runs a JOIN run_leases l ON l.run_id=a.id WHERE a.tenant_id=r.tenant_id AND a.owner_id=r.owner_id AND a.runtime_active AND l.lease_until>clock_timestamp())<$2
          ORDER BY (SELECT max(last_claimed_at) FROM runtime_fairness tf WHERE tf.tenant_id=r.tenant_id) NULLS FIRST,f.last_claimed_at NULLS FIRST,j.priority DESC,j.ready_at,r.id
          LIMIT 1 FOR UPDATE OF r,j SKIP LOCKED`,
          [
            options.tenantSlots ?? 20,
            options.userSlots ?? 2,
            scope.tenant_id ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) return null;
        const lease = await client.query(
          `INSERT INTO run_leases(run_id,worker_id,lease_epoch,lease_until) VALUES($1,$2,1,clock_timestamp()+$3*interval '1 millisecond')
          ON CONFLICT(run_id) DO UPDATE SET worker_id=$2,lease_epoch=run_leases.lease_epoch+1,lease_until=clock_timestamp()+$3*interval '1 millisecond',heartbeat_at=now() RETURNING lease_epoch`,
          [row.id, workerId, leaseMs],
        );
        const epoch = Number(lease.rows[0].lease_epoch);
        await client.query(
          'UPDATE run_jobs SET claimed_epoch=$2,attempt=attempt+1 WHERE run_id=$1',
          [row.id, epoch],
        );
        await client.query(
          `INSERT INTO runtime_fairness(tenant_id,owner_id,last_claimed_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT(tenant_id,owner_id) DO UPDATE SET last_claimed_at=excluded.last_claimed_at`,
          [row.tenant_id, row.owner_id],
        );
        await client.query(
          'UPDATE agent_runs SET attempt=attempt+1,started_at=COALESCE(started_at,now()) WHERE id=$1',
          [row.id],
        );
        const updated = await transition(client, row.id, 'running', {
          runtime_active: true,
        });
        const point = row.checkpoint_id
          ? await client.query(
              'SELECT checkpoint,resume_input FROM run_checkpoints WHERE id=$1',
              [row.checkpoint_id],
            )
          : null;
        return {
          run: dto({ ...updated, last_seq: Number(updated.last_seq) + 1 }),
          actor: row.actor_context,
          lease_epoch: epoch,
          worker_id: workerId,
          checkpoint: point?.rows[0]
            ? CheckpointSchema.parse(point.rows[0].checkpoint)
            : null,
          resume_input: point?.rows[0]?.resume_input ?? null,
        };
      });
    },
    async assertLease(id: string, epoch: number): Promise<void> {
      await tx(async (client) => {
        await lockedLease(client, id, epoch);
      });
    },
    async requeueRun(id: string, epoch: number, delayMs = 1000): Promise<void> {
      await tx(async (client) => {
        await lockedLease(client, id, epoch);
        await transition(client, id, 'queued', { phase: 'waiting_model_slot' });
        await client.query(
          'UPDATE run_leases SET lease_until=now() WHERE run_id=$1',
          [id],
        );
        await client.query(
          "INSERT INTO run_jobs(run_id,ready_at) VALUES($1,clock_timestamp()+$2*interval '1 millisecond') ON CONFLICT(run_id) DO UPDATE SET ready_at=excluded.ready_at",
          [id, delayMs],
        );
      });
    },
    async heartbeat(
      id: string,
      epoch: number,
      workerId: string,
    ): Promise<{ cancel_requested: boolean }> {
      return tx(async (client) => {
        const run = await lockedLease(client, id, epoch, true);
        const result = await client.query(
          `UPDATE run_leases SET lease_until=clock_timestamp()+$4*interval '1 millisecond',heartbeat_at=now()
          WHERE run_id=$1 AND lease_epoch=$2 AND worker_id=$3 RETURNING run_id`,
          [id, epoch, workerId, leaseMs],
        );
        if (!result.rowCount)
          throw new AppError('INVALID_STATE', '任务租约已失效。');
        return { cancel_requested: run.cancel_requested_at !== null };
      });
    },
    async isCancelRequested(id: string, epoch: number) {
      const result = await database.pool.query(
        'SELECT cancel_requested_at FROM agent_runs r JOIN run_leases l ON l.run_id=r.id WHERE r.id=$1 AND l.lease_epoch=$2',
        [id, epoch],
      );
      return !result.rows[0] || result.rows[0].cancel_requested_at !== null;
    },
    async appendEvent(
      id: string,
      epoch: number,
      type: SseEventType,
      payload: unknown,
    ): Promise<SseEvent> {
      return tx(async (client) => {
        await lockedLease(client, id, epoch);
        return event(client, id, type, payload);
      });
    },
    async saveCheckpoint(
      id: string,
      epoch: number,
      input: RunCheckpoint,
    ): Promise<string> {
      const checkpoint = CheckpointSchema.parse(input);
      return tx(async (client) => {
        const row = await lockedLease(client, id, epoch);
        if (
          row.origin === 'subscription' &&
          ['waiting_user', 'waiting_confirmation'].includes(checkpoint.stage)
        )
          throw new AppError('INVALID_STATE', '后台摘要不能等待交互确认。');
        const pointId = randomUUID();
        await client.query(
          'INSERT INTO run_checkpoints(id,run_id,tenant_id,lease_epoch,checkpoint) VALUES($1,$2,$3,$4,$5)',
          [pointId, id, row.tenant_id, epoch, JSON.stringify(checkpoint)],
        );
        await client.query(
          'UPDATE agent_runs SET checkpoint_id=$2 WHERE id=$1',
          [id, pointId],
        );
        if (checkpoint.stage !== 'safe_point') {
          const status =
            checkpoint.stage === 'waiting_domain_job'
              ? 'running'
              : checkpoint.stage;
          await transition(client, id, status, {
            phase: checkpoint.stage,
            runtime_active: false,
          });
          await client.query('DELETE FROM run_jobs WHERE run_id=$1', [id]);
          await client.query(
            'UPDATE run_leases SET lease_until=now() WHERE run_id=$1',
            [id],
          );
        }
        return pointId;
      });
    },
    async completeDomainJob(
      actor: ActorContext,
      id: string,
      checkpointId: string,
      job: { id: string; generation: number },
    ): Promise<boolean> {
      actor = await options.freshActor(actor);
      return tx(async (client) => {
        const row = await owned(client, actor, id, true);
        if (
          row.cancel_requested_at ||
          row.status !== 'running' ||
          row.runtime_active ||
          row.checkpoint_id !== checkpointId
        )
          return false;
        const result = await client.query(
          'SELECT * FROM run_checkpoints WHERE id=$1 AND run_id=$2 FOR UPDATE',
          [checkpointId, id],
        );
        const point = result.rows[0];
        const checkpoint = CheckpointSchema.parse(point?.checkpoint);
        if (
          checkpoint.waiting_job_ref?.id !== job.id ||
          checkpoint.waiting_job_ref.generation !== job.generation ||
          point.resumed_at
        )
          return false;
        await client.query(
          'UPDATE run_checkpoints SET resumed_at=now(),completion_key=$2 WHERE id=$1',
          [checkpointId, `${id}:${checkpointId}:${job.id}:${job.generation}`],
        );
        await client.query(
          'UPDATE agent_runs SET actor_context=$2,authz_version=$3 WHERE id=$1',
          [id, JSON.stringify(actor), actor.authz_version],
        );
        await transition(client, id, 'queued');
        await client.query(
          'INSERT INTO run_jobs(run_id) VALUES($1) ON CONFLICT(run_id) DO UPDATE SET ready_at=now()',
          [id],
        );
        return true;
      });
    },
    async finishRun(
      id: string,
      epoch: number,
      status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
      errorCode: string | null = null,
    ): Promise<void> {
      await tx(async (client) => {
        const row = await lockedLease(client, id, epoch, true);
        const pending = await client.query(
          `SELECT 1 FROM runtime_tool_calls WHERE run_id=$1 AND effect='write' AND status IN ('running','unknown') LIMIT 1`,
          [id],
        );
        if (pending.rowCount) {
          await transition(client, id, 'reconciling', {
            phase: 'pending_receipts',
          });
          return;
        }
        if (row.cancel_requested_at) status = 'cancelled';
        if (
          status === 'succeeded' &&
          completionGuard &&
          !(await completionGuard(client, id))
        ) {
          await transition(client, id, 'queued', { phase: 'pending_input' });
          await client.query(
            'UPDATE run_leases SET lease_until=now() WHERE run_id=$1',
            [id],
          );
          await client.query(
            'INSERT INTO run_jobs(run_id) VALUES($1) ON CONFLICT(run_id) DO UPDATE SET ready_at=now()',
            [id],
          );
          return;
        }
        if (errorCode)
          await event(client, id, 'run.error', {
            code: errorCode,
            message:
              errorCode === 'DEPENDENCY_UNAVAILABLE'
                ? '模型服务未配置或暂时不可用。'
                : '任务已停止，请查看状态后重试。',
          });
        await transition(client, id, status, { error_code: errorCode });
      });
    },
    async recordUsage(
      id: string,
      epoch: number,
      delta: Partial<{
        model_calls: number;
        tool_calls: number;
        input_tokens: number;
        output_tokens: number;
        cached_tokens: number;
        elapsed_ms: number;
      }>,
    ) {
      const recorded = await tx(async (client) => {
        const row = await lockedLease(client, id, epoch);
        const usage = { ...row.usage };
        for (const [key, value] of Object.entries(delta)) {
          if (!Number.isSafeInteger(value) || value < 0)
            throw new AppError('VALIDATION_ERROR', '用量记录无效。');
          usage[key] = (usage[key] ?? 0) + value;
        }
        const exceeded =
          usage.model_calls > row.budgets.model_calls ||
          usage.tool_calls > row.budgets.tool_calls ||
          usage.output_tokens > row.budgets.output_tokens ||
          usage.elapsed_ms > row.budgets.active_ms;
        if (
          ((delta.model_calls ?? 0) > 0 &&
            (usage.model_calls > row.budgets.model_calls ||
              row.usage.output_tokens >= row.budgets.output_tokens ||
              row.usage.elapsed_ms >= row.budgets.active_ms)) ||
          ((delta.tool_calls ?? 0) > 0 &&
            usage.tool_calls > row.budgets.tool_calls)
        )
          throw new AppError(
            'RATE_LIMITED',
            '任务已达运行预算，请缩小范围后继续。',
            { details: { reason: 'RUN_BUDGET_EXCEEDED' } },
          );
        await client.query('UPDATE agent_runs SET usage=$2 WHERE id=$1', [
          id,
          JSON.stringify(usage),
        ]);
        await event(client, id, 'usage.updated', usage);
        return { usage, exceeded };
      });
      if (recorded.exceeded)
        throw new AppError(
          'RATE_LIMITED',
          '任务已达运行预算，请缩小范围后继续。',
          { details: { reason: 'RUN_BUDGET_EXCEEDED' } },
        );
      return recorded.usage;
    },
    async beginTool(
      id: string,
      epoch: number,
      input: {
        call_id: string;
        name: string;
        version: string;
        arguments: unknown;
        effect: 'read' | 'propose' | 'write';
      },
    ): Promise<{ cached: ToolResult | null }> {
      return tx(async (client) => {
        const row = await lockedLease(client, id, epoch);
        const old = await client.query(
          'SELECT * FROM runtime_tool_calls WHERE call_id=$1',
          [input.call_id],
        );
        if (old.rows[0]) {
          const call = old.rows[0];
          if (
            call.run_id !== id ||
            call.input_hash !== runPayloadHash(input.arguments) ||
            call.tool_name !== input.name ||
            call.tool_version !== input.version
          )
            throw new AppError('IDEMPOTENCY_CONFLICT', '工具调用标识冲突。');
          if (call.status === 'completed')
            return { cached: call.result as ToolResult };
          throw new AppError('INVALID_STATE', '工具调用仍在执行或等待核实。');
        }
        if (row.usage.tool_calls >= row.budgets.tool_calls)
          throw new AppError('RATE_LIMITED', '任务已达工具调用预算。', {
            details: { reason: 'RUN_BUDGET_EXCEEDED' },
          });
        await client.query(
          `INSERT INTO runtime_tool_calls(call_id,run_id,tool_name,tool_version,input_hash,effect,status,lease_epoch) VALUES($1,$2,$3,$4,$5,$6,'running',$7)`,
          [
            input.call_id,
            id,
            input.name,
            input.version,
            runPayloadHash(input.arguments),
            input.effect,
            epoch,
          ],
        );
        await client.query(
          "UPDATE agent_runs SET usage=jsonb_set(usage,'{tool_calls}',to_jsonb((usage->>'tool_calls')::int+1)) WHERE id=$1",
          [id],
        );
        await event(client, id, 'tool.started', {
          call_id: input.call_id,
          name: input.name,
        });
        return { cached: null };
      });
    },
    async completeTool(
      id: string,
      epoch: number,
      callId: string,
      result: ToolResult,
    ) {
      await tx(async (client) => {
        await lockedLease(client, id, epoch, true);
        const updated = await client.query(
          `UPDATE runtime_tool_calls SET status=$4,result=$5,action_id=$6,error_code=$7,finished_at=now()
          WHERE call_id=$1 AND run_id=$2 AND lease_epoch=$3 AND status='running' RETURNING call_id`,
          [
            callId,
            id,
            epoch,
            result.status === 'unknown'
              ? 'unknown'
              : result.status === 'error'
                ? 'failed'
                : 'completed',
            JSON.stringify(result),
            result.action_id,
            result.error_code,
          ],
        );
        if (!updated.rowCount)
          throw new AppError(
            'INVALID_STATE',
            '工具调用已完成或不属于当前租约。',
          );
        await event(client, id, 'tool.completed', {
          call_id: callId,
          status: result.status,
          action_id: result.action_id,
          error_code: result.error_code,
        });
      });
    },
    async executionState(id: string, epoch: number) {
      const row = await tx((client) => lockedLease(client, id, epoch));
      const actor = await options.freshActor(row.actor_context as ActorContext);
      const point = row.checkpoint_id
        ? await database.pool.query(
            'SELECT checkpoint,resume_input FROM run_checkpoints WHERE id=$1',
            [row.checkpoint_id],
          )
        : null;
      const calls = await database.pool.query(
        `SELECT call_id,tool_name,tool_version,result,action_id FROM runtime_tool_calls WHERE run_id=$1 AND status='completed' ORDER BY finished_at,call_id`,
        [id],
      );
      return {
        run: dto(row),
        actor,
        checkpoint: point?.rows[0]
          ? CheckpointSchema.parse(point.rows[0].checkpoint)
          : null,
        resume_input: point?.rows[0]?.resume_input ?? null,
        completed_tools: calls.rows,
      };
    },
    async reconcileRun(
      id: string,
      lookup: (actor: ActorContext, actionId: string) => Promise<ToolResult>,
    ): Promise<boolean> {
      const selected = await database.pool.query(
        "SELECT * FROM agent_runs WHERE id=$1 AND status='reconciling'",
        [id],
      );
      const row = selected.rows[0];
      if (!row) return false;
      const actor = await options.freshActor(row.actor_context as ActorContext);
      const calls = await database.pool.query(
        `SELECT call_id,action_id FROM runtime_tool_calls WHERE run_id=$1 AND effect='write' AND status IN ('running','unknown')`,
        [id],
      );
      const receipts = new Map<string, ToolResult>();
      for (const call of calls.rows) {
        if (!call.action_id) return false;
        const result = await lookup(actor, call.action_id);
        if (result.status === 'unknown') return false;
        receipts.set(call.call_id, result);
      }
      return tx(async (client) => {
        const current = await client.query(
          "SELECT * FROM agent_runs WHERE id=$1 AND status='reconciling' FOR UPDATE",
          [id],
        );
        if (!current.rows[0]) return false;
        for (const [callId, result] of receipts) {
          const changed = await client.query(
            `UPDATE runtime_tool_calls SET status=$3,result=$4,error_code=$5,finished_at=now() WHERE run_id=$1 AND call_id=$2 AND status IN ('running','unknown') RETURNING call_id`,
            [
              id,
              callId,
              result.status === 'ok' ? 'completed' : 'failed',
              JSON.stringify(result),
              result.error_code,
            ],
          );
          if (changed.rowCount)
            await event(client, id, 'tool.completed', {
              call_id: callId,
              status: result.status,
              action_id: result.action_id,
              error_code: result.error_code,
              reconciled: true,
            });
        }
        const pending = await client.query(
          `SELECT 1 FROM runtime_tool_calls WHERE run_id=$1 AND effect='write' AND status IN ('running','unknown') LIMIT 1`,
          [id],
        );
        if (pending.rowCount) return false;
        await transition(
          client,
          id,
          current.rows[0].cancel_requested_at ? 'cancelled' : 'queued',
          { phase: 'receipt_recovered' },
        );
        if (!current.rows[0].cancel_requested_at)
          await client.query(
            'INSERT INTO run_jobs(run_id) VALUES($1) ON CONFLICT(run_id) DO UPDATE SET ready_at=now()',
            [id],
          );
        await audit(client, current.rows[0], 'system', 'run.reconcile');
        return true;
      });
    },
    async recoverExpired(scope: { tenant_id?: string } = {}): Promise<number> {
      return tx(async (client) => {
        const result = await client.query(
          `SELECT r.* FROM agent_runs r JOIN run_leases l ON l.run_id=r.id
          WHERE r.status='running' AND r.runtime_active AND l.lease_until<=clock_timestamp()
          AND ($1::text IS NULL OR r.tenant_id=$1) FOR UPDATE OF r SKIP LOCKED LIMIT 100`,
          [scope.tenant_id ?? null],
        );
        for (const row of result.rows) {
          const writes = await client.query(
            `SELECT 1 FROM runtime_tool_calls WHERE run_id=$1 AND effect='write' AND status IN ('running','unknown') LIMIT 1`,
            [row.id],
          );
          await client.query(
            'UPDATE run_leases SET lease_epoch=lease_epoch+1 WHERE run_id=$1',
            [row.id],
          );
          if (writes.rowCount)
            await transition(client, row.id, 'reconciling', {
              phase: 'pending_receipts',
            });
          else if (row.cancel_requested_at)
            await transition(client, row.id, 'cancelled');
          else if (row.recovery_count < 1) {
            await client.query(
              'UPDATE agent_runs SET recovery_count=recovery_count+1 WHERE id=$1',
              [row.id],
            );
            await transition(client, row.id, 'queued', {
              phase: 'readonly_recovery',
            });
            await client.query(
              'INSERT INTO run_jobs(run_id) VALUES($1) ON CONFLICT(run_id) DO UPDATE SET ready_at=now()',
              [row.id],
            );
          } else {
            if (!row.checkpoint_id) {
              const point = CheckpointSchema.parse({ stage: 'interrupted' });
              const pointId = randomUUID();
              await client.query(
                'INSERT INTO run_checkpoints(id,run_id,tenant_id,lease_epoch,checkpoint) VALUES($1,$2,$3,0,$4)',
                [pointId, row.id, row.tenant_id, JSON.stringify(point)],
              );
              await client.query(
                'UPDATE agent_runs SET checkpoint_id=$2 WHERE id=$1',
                [row.id, pointId],
              );
            }
            await transition(client, row.id, 'interrupted', {
              error_code: 'WORKER_LOST',
            });
          }
          await audit(client, row, 'system', 'run.recover');
        }
        return result.rowCount ?? 0;
      });
    },
    async pruneEvents(before: Date): Promise<void> {
      await tx(async (client) => {
        // 最终消息与卡片留作快照；仅清理过期流式片段，floor 防止不完整回放。
        const runs = await client.query(
          `SELECT run_id,max(seq) AS seq FROM run_events WHERE occurred_at<$1 AND type NOT IN ('assistant.message','card.upsert','confirmation.required') GROUP BY run_id`,
          [before],
        );
        for (const row of runs.rows) {
          await client.query(
            'UPDATE agent_runs SET event_floor=GREATEST(event_floor,$2::bigint+1) WHERE id=$1',
            [row.run_id, row.seq],
          );
        }
        await client.query(
          `DELETE FROM run_events WHERE occurred_at<$1 AND type NOT IN ('assistant.message','card.upsert','confirmation.required')`,
          [before],
        );
      });
    },
    async operations(actor: ActorContext) {
      actor = await options.freshActor(actor);
      if (!actor.permissions.includes('operations.read'))
        throw new AppError('FORBIDDEN', '没有任务运维查看权限。');
      const result = await database.pool.query(
        `SELECT id,status,phase,runtime_active,created_at,started_at,finished_at,error_code,attempt,usage,last_seq FROM agent_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [actor.tenant_id],
      );
      return result.rows;
    },
  };
  return service;
}
export type RunService = ReturnType<typeof createRunService>;
