import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  ActorContext,
  AgentCard,
  ResourceRef,
  SseEvent,
} from '@caixiaozhi/contracts';
import { AgentCardSchema } from '@caixiaozhi/contracts/cards';
import {
  AcceptMessageSchema,
  CreateThreadSchema,
  MessageSchema,
  ThreadSchema,
  type AcceptMessage,
} from '@caixiaozhi/contracts/assistant';
import type { RunService } from '@caixiaozhi/agent-runtime';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  idempotent,
  iso,
  lockOwner,
  transaction,
  type Row,
} from './database.js';

export type AssistantOptions = {
  runs: RunService;
  freshActor: (actor: ActorContext) => Promise<ActorContext>;
  authorizeResource?: (
    actor: ActorContext,
    ref: ResourceRef,
  ) => Promise<ResourceRef>;
  authorizeAttachment?: (actor: ActorContext, id: string) => Promise<void>;
  home?: (actor: ActorContext) => Promise<unknown>;
  drawer?: (
    actor: ActorContext,
    card: AgentCard,
    input: unknown,
  ) => Promise<unknown>;
  invalidateConfirmation?: (actor: ActorContext, id: string) => Promise<void>;
  unreadCount?: (actor: ActorContext) => Promise<number>;
};
const threadDto = (row: Row) =>
  ThreadSchema.parse({
    ...row,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    deleted_at: undefined,
  });
const cleanThread = (row: Row) =>
  ThreadSchema.parse(
    Object.fromEntries(
      Object.keys(ThreadSchema.shape).map((key) => [
        key,
        ['created_at', 'updated_at'].includes(key) ? iso(row[key]) : row[key],
      ]),
    ),
  );
const messageDto = (row: Row) =>
  MessageSchema.parse(
    Object.fromEntries(
      Object.keys(MessageSchema.shape).map((key) => [
        key,
        key === 'created_at' ? iso(row[key]) : row[key],
      ]),
    ),
  );
const entries: Record<string, { title: string; prompt: string }> = {
  'approval-review': {
    title: '待我审批',
    prompt: '请检查当前待我审批的报销，给出风险和材料概要。',
  },
  'prepare-expense': {
    title: '准备报销',
    prompt: '请帮我准备报销，先说明所需材料。',
  },
  'expense-analysis': {
    title: '费用分析',
    prompt: '请分析本月有权查看的费用，注明指标口径和来源。',
  },
  'policy-question': {
    title: '政策问答',
    prompt: '我想查询报销政策，请提示我补充具体问题。',
  },
};
export function createAssistantService(
  database: DatabaseConnection,
  options: AssistantOptions,
) {
  async function own(
    client: Pick<PoolClient, 'query'>,
    actor: ActorContext,
    id: string,
    lock = false,
  ): Promise<Row> {
    const result = await client.query(
      `SELECT * FROM threads WHERE tenant_id=$1 AND owner_id=$2 AND id=$3 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [actor.tenant_id, actor.user_id, id],
    );
    if (!result.rows[0]) throw new AppError('NOT_FOUND', '会话不存在。');
    return result.rows[0];
  }
  async function resourceAccess(actor: ActorContext, refs: ResourceRef[]) {
    if (refs.length && !options.authorizeResource)
      throw new AppError('NOT_FOUND', '资源不可查看。');
    for (const ref of refs) await options.authorizeResource!(actor, ref);
  }
  async function accept(
    client: PoolClient,
    actor: ActorContext,
    threadId: string,
    input: AcceptMessage,
  ) {
    const row = await own(client, actor, threadId, true);
    const old = await client.query(
      'SELECT * FROM messages WHERE tenant_id=$1 AND owner_id=$2 AND client_message_id=$3',
      [actor.tenant_id, actor.user_id, input.client_message_id],
    );
    if (old.rows[0]) {
      if (
        old.rows[0].thread_id !== threadId ||
        old.rows[0].content !== input.content ||
        JSON.stringify(old.rows[0].resource_refs) !==
          JSON.stringify(input.resource_refs) ||
        JSON.stringify(old.rows[0].attachment_ids) !==
          JSON.stringify(input.attachment_ids)
      )
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          '该消息标识已用于不同内容。',
        );
      return {
        thread: cleanThread(row),
        message: messageDto(old.rows[0]),
        run_id: old.rows[0].run_id as string | null,
        disposition: 'reused',
      };
    }
    if (row.version !== input.expected_version)
      throw new AppError('VERSION_CONFLICT', '会话已更新，请刷新后发送。', {
        details: { current_version: row.version },
      });
    await resourceAccess(actor, input.resource_refs);
    if (input.attachment_ids.length && !options.authorizeAttachment)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '附件服务尚未就绪。');
    for (const id of input.attachment_ids)
      await options.authorizeAttachment!(actor, id);
    const active = await client.query(
      `SELECT * FROM agent_runs WHERE tenant_id=$1 AND thread_id=$2 AND status NOT IN ('succeeded','failed','cancelled') FOR UPDATE`,
      [actor.tenant_id, threadId],
    );
    const run = active.rows[0];
    if (run && input.intent === 'new_task')
      throw new AppError('INVALID_STATE', '当前会话已有任务，请另开会话。');
    if (run && ['interrupted', 'reconciling'].includes(run.status))
      throw new AppError(
        'INVALID_STATE',
        run.status === 'interrupted'
          ? '请先继续或结束已中断任务。'
          : '正在核实写入结果，请等待回执。',
      );
    const id = randomUUID();
    const seq = row.last_message_seq + 1;
    const pending = run && ['queued', 'running'].includes(run.status);
    await client.query(
      'UPDATE threads SET last_message_seq=$2,version=version+1,updated_at=now() WHERE id=$1',
      [threadId, seq],
    );
    const saved = await client.query(
      `INSERT INTO messages(id,tenant_id,owner_id,thread_id,seq,role,content,client_message_id,status,resource_refs,attachment_ids,run_id,authz_version) VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        id,
        actor.tenant_id,
        actor.user_id,
        threadId,
        seq,
        input.content,
        input.client_message_id,
        pending ? 'pending_consumption' : 'accepted',
        JSON.stringify(input.resource_refs),
        JSON.stringify(input.attachment_ids),
        run?.id ?? null,
        actor.authz_version,
      ],
    );
    let runId = run?.id as string | undefined;
    if (!run) {
      const created = await options.runs.createRun(
        actor,
        {
          thread_id: threadId,
          input_message_id: id,
          selected_skill_version_id: input.selected_skill_version_id,
        },
        `message:${input.client_message_id}`,
        { client, threadAuthorized: true },
      );
      runId = created.id;
      await client.query('UPDATE messages SET run_id=$2 WHERE id=$1', [
        id,
        runId,
      ]);
    } else if (run.status === 'waiting_user')
      await options.runs.resumeRun(
        actor,
        run.id,
        {
          expected_version: run.version,
          checkpoint_id: run.checkpoint_id,
          input: { message_id: id },
        },
        `message:${input.client_message_id}`,
        { client },
      );
    else if (run.status === 'waiting_confirmation') {
      if (!options.invalidateConfirmation)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '请先刷新待确认操作，再补充或修改范围。',
        );
      const point = await client.query(
        'SELECT checkpoint FROM run_checkpoints WHERE id=$1',
        [run.checkpoint_id],
      );
      const confirmation = point.rows[0]?.checkpoint?.pending_confirmation_id;
      if (confirmation)
        await options.invalidateConfirmation(actor, confirmation);
      await client.query(
        "UPDATE messages SET status='pending_consumption' WHERE id=$1",
        [id],
      );
    }
    await client.query('UPDATE threads SET active_run_id=$2 WHERE id=$1', [
      threadId,
      runId,
    ]);
    const current = await own(client, actor, threadId);
    return {
      thread: cleanThread(current),
      message: messageDto({ ...saved.rows[0], run_id: runId }),
      run_id: runId!,
      disposition: pending
        ? 'pending_consumption'
        : run
          ? 'continued'
          : 'queued',
    };
  }
  async function create(
    client: PoolClient,
    actor: ActorContext,
    input: ReturnType<typeof CreateThreadSchema.parse>,
  ) {
    const id = randomUUID();
    const result = await client.query(
      'INSERT INTO threads(id,tenant_id,owner_id,title) VALUES($1,$2,$3,$4) RETURNING *',
      [id, actor.tenant_id, actor.user_id, input.title ?? '新的财务任务'],
    );
    if (input.initial_message)
      return accept(client, actor, id, {
        ...input.initial_message,
        expected_version: 1,
      });
    return {
      thread: cleanThread(result.rows[0]),
      message: null,
      run_id: null,
      disposition: 'created',
    };
  }
  const service = {
    async home(actor: ActorContext) {
      actor = await options.freshActor(actor);
      return {
        entries: Object.entries(entries).map(([key, value]) => ({
          key,
          title: value.title,
        })),
        business: options.home ? await options.home(actor) : null,
        unread_count: (await options.unreadCount?.(actor)) ?? 0,
      };
    },
    async createThread(actor: ActorContext, input: unknown, key: string) {
      actor = await options.freshActor(actor);
      const parsed = CreateThreadSchema.parse(input);
      return idempotent(
        database,
        actor,
        'thread.create',
        key,
        parsed,
        (client) => create(client, actor, parsed),
      );
    },
    async acceptMessage(
      actor: ActorContext,
      id: string,
      input: unknown,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const parsed = AcceptMessageSchema.parse(input);
      return idempotent(
        database,
        actor,
        `message.accept:${id}`,
        key,
        parsed,
        (client) => accept(client, actor, id, parsed),
      );
    },
    async listThreads(actor: ActorContext) {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        'SELECT * FROM threads WHERE tenant_id=$1 AND owner_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 100',
        [actor.tenant_id, actor.user_id],
      );
      return { items: result.rows.map(cleanThread), next_cursor: null };
    },
    async authorizeThread(
      actor: ActorContext,
      threadId: string,
      messageId?: string,
    ) {
      actor = await options.freshActor(actor);
      await own(database.pool, actor, threadId);
      if (messageId) {
        const result = await database.pool.query(
          "SELECT 1 FROM messages WHERE tenant_id=$1 AND owner_id=$2 AND thread_id=$3 AND id=$4 AND role='user'",
          [actor.tenant_id, actor.user_id, threadId, messageId],
        );
        if (!result.rowCount) throw new AppError('NOT_FOUND', '消息不存在。');
      }
    },
    async snapshot(actor: ActorContext, id: string) {
      actor = await options.freshActor(actor);
      const state = await transaction(database, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const thread = await own(client, actor, id);
        const messages = await client.query(
          'SELECT m.*,r.authz_version AS run_authz_version FROM messages m LEFT JOIN agent_runs r ON r.id=m.run_id WHERE m.tenant_id=$1 AND m.thread_id=$2 ORDER BY m.seq',
          [actor.tenant_id, id],
        );
        const cards = await client.query(
          'SELECT card FROM cards WHERE tenant_id=$1 AND owner_id=$2 AND thread_id=$3 ORDER BY created_at,id',
          [actor.tenant_id, actor.user_id, id],
        );
        const run = thread.active_run_id
          ? await client.query(
              'SELECT last_seq,status FROM agent_runs WHERE id=$1',
              [thread.active_run_id],
            )
          : await client.query(
              'SELECT id,last_seq,status FROM agent_runs WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
              [actor.tenant_id, id],
            );
        return {
          thread: cleanThread(thread),
          messages: messages.rows.map((row) =>
            messageDto(
              row.role !== 'user' && row.authz_version !== actor.authz_version
                ? {
                    ...row,
                    content: '权限已变化，请重新查询当前有权查看的数据。',
                    resource_refs: [],
                  }
                : row,
            ),
          ),
          cards: cards.rows.map((row) => row.card as AgentCard),
          through_seq: Number(run?.rows[0]?.last_seq ?? 0),
          last_run_id: thread.active_run_id ?? run?.rows[0]?.id ?? null,
          snapshot_at: new Date().toISOString(),
        };
      });
      const cards = [];
      for (const card of state.cards)
        cards.push(await service.projectCard(actor, card));
      // 资源失权消息的旧正文也不透出；用户原始输入保留，业务结果隐藏。
      const visible = [];
      for (const message of state.messages) {
        try {
          await resourceAccess(actor, message.resource_refs);
          visible.push(message);
        } catch {
          visible.push({
            ...message,
            content: '此消息引用的数据已不可查看。',
            resource_refs: [],
          });
        }
      }
      return {
        ...state,
        messages: visible,
        cards,
        active_run: state.thread.active_run_id
          ? await options.runs.getRun(actor, state.thread.active_run_id)
          : null,
        last_run: state.last_run_id
          ? await options.runs.getRun(actor, state.last_run_id)
          : null,
      };
    },
    async renameThread(
      actor: ActorContext,
      id: string,
      input: { title: string; expected_version: number },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      return idempotent(
        database,
        actor,
        `thread.rename:${id}`,
        key,
        input,
        async (client) => {
          const thread = await own(client, actor, id, true);
          if (thread.version !== input.expected_version)
            throw new AppError('VERSION_CONFLICT', '会话已更新。');
          const result = await client.query(
            'UPDATE threads SET title=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',
            [id, input.title],
          );
          return cleanThread(result.rows[0]);
        },
      );
    },
    async deleteThread(
      actor: ActorContext,
      id: string,
      expectedVersion: number,
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const state = await own(database.pool, actor, id);
      if (state.active_run_id) {
        const run = await options.runs.getRun(actor, state.active_run_id);
        if (!['succeeded', 'failed', 'cancelled'].includes(run.status))
          await options.runs.cancelRun(
            actor,
            run.id,
            { expected_version: run.version, reason: '删除会话' },
            `delete-thread:${key}`,
          );
      }
      return idempotent(
        database,
        actor,
        `thread.delete:${id}`,
        key,
        { expected_version: expectedVersion },
        async (client) => {
          const row = await own(client, actor, id, true);
          if (row.version !== expectedVersion && row.active_run_id === null)
            throw new AppError('VERSION_CONFLICT', '会话已更新。');
          await client.query(
            'UPDATE threads SET deleted_at=now(),version=version+1,updated_at=now() WHERE id=$1',
            [id],
          );
          await client.query(
            "UPDATE memories SET status='source_unavailable',version=version+1,updated_at=now() WHERE tenant_id=$1 AND owner_id=$2 AND source_message_id IN (SELECT id FROM messages WHERE tenant_id=$1 AND thread_id=$3) AND status='active'",
            [actor.tenant_id, actor.user_id, id],
          );
          await client.query(
            'INSERT INTO memory_profiles(tenant_id,owner_id,memory_epoch) VALUES($1,$2,1) ON CONFLICT(tenant_id,owner_id) DO UPDATE SET memory_epoch=memory_profiles.memory_epoch+1,updated_at=now()',
            [actor.tenant_id, actor.user_id],
          );
          return { deleted: true };
        },
      );
    },
    async projectCard(actor: ActorContext, card: AgentCard) {
      try {
        const authorization = await database.pool.query(
          'SELECT authz_version FROM cards WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',
          [actor.tenant_id, actor.user_id, card.id],
        );
        if (
          !authorization.rows[0] ||
          authorization.rows[0].authz_version !== actor.authz_version
        )
          throw new Error('permission_context_changed');
        const current = [];
        for (const ref of card.resource_refs) {
          if (!options.authorizeResource) throw new Error();
          current.push(await options.authorizeResource(actor, ref));
        }
        return {
          ...AgentCardSchema.parse(card),
          stale: current.some(
            (ref, i) => ref.version !== card.resource_refs[i]?.version,
          ),
        };
      } catch {
        return {
          id: card.id,
          unavailable: true,
          title: '此卡片引用的数据已不可查看。',
          actions: [],
        };
      }
    },
    async getCard(actor: ActorContext, id: string) {
      actor = await options.freshActor(actor);
      const result = await database.pool.query(
        'SELECT c.card FROM cards c JOIN threads t ON t.id=c.thread_id WHERE c.tenant_id=$1 AND c.owner_id=$2 AND c.id=$3 AND t.deleted_at IS NULL',
        [actor.tenant_id, actor.user_id, id],
      );
      if (!result.rows[0]) throw new AppError('NOT_FOUND', '卡片不存在。');
      return service.projectCard(actor, result.rows[0].card);
    },
    async drawer(actor: ActorContext, id: string, input: unknown) {
      actor = await options.freshActor(actor);
      const projection = await service.getCard(actor, id);
      if ('unavailable' in projection)
        throw new AppError('NOT_FOUND', '资源不存在。');
      if (!options.drawer)
        throw new AppError('DEPENDENCY_UNAVAILABLE', '此详情服务尚未就绪。');
      return options.drawer(actor, projection, input);
    },
    async openEntry(
      actor: ActorContext,
      entry: string,
      input: {
        client_message_id: string;
        expected_binding_version: number | null;
      },
      key: string,
    ) {
      actor = await options.freshActor(actor);
      const definition = entries[entry];
      if (!definition) throw new AppError('NOT_FOUND', '入口不存在。');
      return idempotent(
        database,
        actor,
        `entry.open:${entry}`,
        key,
        input,
        async (client) => {
          const result = await client.query(
            'SELECT b.*,t.deleted_at FROM thread_entry_bindings b JOIN threads t ON t.id=b.thread_id WHERE b.tenant_id=$1 AND b.owner_id=$2 AND b.entry_key=$3 FOR UPDATE OF b',
            [actor.tenant_id, actor.user_id, entry],
          );
          const binding = result.rows[0];
          if (binding && !binding.deleted_at) {
            if (
              input.expected_binding_version !== null &&
              input.expected_binding_version !== binding.version
            )
              throw new AppError('VERSION_CONFLICT', '入口会话已更新。');
            return {
              thread_id: binding.thread_id,
              run_id: (await own(client, actor, binding.thread_id))
                .active_run_id,
              binding_version: binding.version,
              reused: true,
            };
          }
          const created = await create(client, actor, {
            title: definition.title,
            initial_message: {
              content: definition.prompt,
              client_message_id: input.client_message_id,
              intent: 'continue',
              resource_refs: [],
              attachment_ids: [],
            },
          });
          const next = await client.query(
            'INSERT INTO thread_entry_bindings(tenant_id,owner_id,entry_key,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,owner_id,entry_key) DO UPDATE SET thread_id=$4,version=thread_entry_bindings.version+1,last_opened_at=now() RETURNING version',
            [actor.tenant_id, actor.user_id, entry, created.thread.id],
          );
          return {
            thread_id: created.thread.id,
            run_id: created.run_id,
            binding_version: next.rows[0].version,
            reused: false,
          };
        },
      );
    },
    async persistEvent(client: PoolClient, event: SseEvent) {
      const result = await client.query(
        'SELECT * FROM agent_runs WHERE id=$1',
        [event.run_id],
      );
      const run = result.rows[0];
      if (!run?.thread_id) return;
      const thread = await client.query(
        'SELECT * FROM threads WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
        [run.thread_id],
      );
      if (!thread.rows[0]) return;
      if (event.type === 'run.status') {
        const payload = event.payload as Row;
        await client.query(
          'UPDATE threads SET active_run_id=$2,version=version+1,updated_at=now() WHERE id=$1',
          [
            run.thread_id,
            ['succeeded', 'failed', 'cancelled'].includes(payload.status)
              ? null
              : run.id,
          ],
        );
        return;
      }
      if (event.type === 'assistant.message') {
        const payload = event.payload as Row;
        if (typeof payload.text !== 'string') return;
        const id = String(payload.id ?? `assistant:${run.id}`);
        const existing = await client.query(
          'SELECT id FROM messages WHERE tenant_id=$1 AND id=$2',
          [run.tenant_id, id],
        );
        if (existing.rowCount) {
          await client.query(
            "UPDATE messages SET content=$3,version=version+1,authz_version=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND run_id=$4 AND role='assistant'",
            [run.tenant_id, id, payload.text, run.id, run.authz_version],
          );
          return;
        }
        const refs = await client.query(
          'SELECT resource_refs FROM messages WHERE id=$1',
          [run.input_message_id],
        );
        const seq = thread.rows[0].last_message_seq + 1;
        await client.query(
          "INSERT INTO messages(id,tenant_id,owner_id,thread_id,seq,role,content,status,run_id,resource_refs,authz_version) VALUES($1,$2,$3,$4,$5,'assistant',$6,'final',$7,$8,$9)",
          [
            id,
            run.tenant_id,
            run.owner_id,
            run.thread_id,
            seq,
            payload.text,
            run.id,
            JSON.stringify(refs.rows[0]?.resource_refs ?? []),
            run.authz_version,
          ],
        );
        await client.query(
          'UPDATE threads SET last_message_seq=$2,version=version+1,updated_at=now() WHERE id=$1',
          [run.thread_id, seq],
        );
        return;
      }
      if (event.type === 'card.upsert') {
        const card = AgentCardSchema.parse(event.payload);
        if (card.thread_id !== run.thread_id || card.run_id !== run.id)
          throw new AppError('VALIDATION_ERROR', '卡片运行归属不匹配。');
        const message = await client.query(
          'SELECT thread_id,owner_id FROM messages WHERE tenant_id=$1 AND id=$2',
          [run.tenant_id, card.message_id],
        );
        if (
          message.rows[0]?.thread_id !== run.thread_id ||
          message.rows[0]?.owner_id !== run.owner_id
        )
          throw new AppError('VALIDATION_ERROR', '卡片消息归属不匹配。');
        await client.query(
          `INSERT INTO cards(id,tenant_id,owner_id,thread_id,message_id,run_id,type,card,revision,snapshot_at,authz_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO UPDATE SET card=$8,revision=$9,authz_version=$11,version=cards.version+1,updated_at=now() WHERE cards.revision<$9 AND cards.tenant_id=$2 AND cards.owner_id=$3 AND cards.thread_id=$4`,
          [
            card.id,
            run.tenant_id,
            run.owner_id,
            run.thread_id,
            card.message_id,
            run.id,
            card.type,
            JSON.stringify(card),
            card.revision,
            card.snapshot_at,
            run.authz_version,
          ],
        );
      }
    },
    async runtimePrompt(actor: ActorContext, runId: string) {
      actor = await options.freshActor(actor);
      const run = await options.runs.getRun(actor, runId);
      if (!run.thread_id)
        throw new AppError('INVALID_STATE', '后台摘要没有会话。');
      await own(database.pool, actor, run.thread_id);
      const result = await database.pool.query(
        'SELECT id,role,content,resource_refs,authz_version FROM messages WHERE tenant_id=$1 AND owner_id=$2 AND thread_id=$3 ORDER BY seq DESC LIMIT 20',
        [actor.tenant_id, actor.user_id, run.thread_id],
      );
      const texts = [];
      for (const row of result.rows.reverse()) {
        if (row.role !== 'user' && row.authz_version !== actor.authz_version)
          continue;
        await resourceAccess(actor, row.resource_refs);
        texts.push(`[${row.role}] ${row.content}`);
      }
      return texts.join('\n\n');
    },
  };
  options.runs.setEventSink(service.persistEvent);
  options.runs.setCompletionGuard(async (client, runId) => {
    const pending = await client.query(
      "UPDATE messages SET status='accepted',updated_at=now() WHERE run_id=$1 AND role='user' AND status='pending_consumption' RETURNING id",
      [runId],
    );
    return !pending.rowCount;
  });
  return service;
}
export type AssistantService = ReturnType<typeof createAssistantService>;
