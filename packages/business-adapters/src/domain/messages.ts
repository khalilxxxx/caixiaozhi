import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  ActionReceipt,
  ResourceRef,
} from '@caixiaozhi/contracts/common';
import {
  OaMessageDraftSchema,
  OaMessageSaveSchema,
} from '@caixiaozhi/contracts/oa';
import { AppError } from '@caixiaozhi/platform/errors';
import type { ActionHandler } from '../ports.js';
import { DocumentService } from './documents.js';
import { ApprovalService } from './approvals.js';
import { canonicalJson } from '@caixiaozhi/platform/hash';
import { rows, idempotent, missing, conflict, validation } from './store.js';

const SendArgsSchema = z.strictObject({
  message_draft_id: z.string(),
  expected_draft_version: z.number().int().positive(),
  recipient_ids: z.array(z.string()).min(1).max(20),
  subject: z.string().min(1).max(100),
  body: z.string().min(1).max(2000),
});
type MessageRow = {
  id: string;
  version: number;
  owner_id: string;
  sender_id: string;
  message_kind: string;
  subject: string;
  body: string;
  recipient_ids: string[];
  resource_ref: ResourceRef;
  state: string;
  created_at: Date;
  sent_at: Date | null;
};
export class BusinessMessageService {
  constructor(
    readonly documents: DocumentService,
    readonly approvals: ApprovalService,
  ) {}
  async recipients(
    actor: ActorContext,
    ref: ResourceRef,
    recipients: string[],
  ) {
    const document = await this.documents.get(
      actor,
      ref.type as 'travel' | 'expense_claim' | 'oa_request',
      ref.id,
    );
    const tasks = await rows<{ assigned_to: string }>(
      this.documents.database.db,
      sql`SELECT assigned_to FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND resource_type=${ref.type} AND resource_id=${ref.id}`,
    );
    const allowed = new Set([
      document.owner_id,
      actor.user_id,
      ...tasks.map((task) => task.assigned_to),
    ]);
    if (recipients.some((id) => !allowed.has(id)))
      throw validation('收件人必须是当前单据参与人。');
    const active = await rows<{ id: string }>(
      this.documents.database.db,
      sql`SELECT id FROM identities WHERE tenant_id=${actor.tenant_id} AND id=ANY(${sql.param(recipients)}::text[]) AND state='active'`,
    );
    if (active.length !== new Set(recipients).size)
      throw validation('收件人已失效，请重新选择。');
    return document;
  }
  async save(
    actor: ActorContext,
    id: string | null,
    input: unknown,
    key: string,
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor),
      parsed = id
        ? OaMessageSaveSchema.parse(input)
        : OaMessageDraftSchema.parse(input);
    await this.recipients(current, parsed.resource_ref, parsed.recipient_ids);
    return idempotent(
      this.documents.database,
      current,
      id ? 'oa.message.save' : 'oa.message.create',
      key,
      { id, ...parsed },
      async (tx) => {
        if (id) {
          const [row] = await rows<MessageRow>(
            tx,
            sql`SELECT * FROM demo_messages WHERE tenant_id=${current.tenant_id} AND id=${id} AND owner_id=${current.user_id} FOR UPDATE`,
          );
          if (!row) throw missing();
          if (row.state !== 'draft')
            throw new AppError(
              'INVALID_STATE',
              '已发送消息不能修改，请新建更正消息。',
            );
          if (
            row.version !==
            ('expected_version' in parsed ? parsed.expected_version : 0)
          )
            throw conflict();
          await tx.execute(
            sql`UPDATE demo_messages SET subject=${parsed.subject},body=${parsed.body},recipient_ids=${JSON.stringify(parsed.recipient_ids)}::jsonb,resource_ref=${JSON.stringify(parsed.resource_ref)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
          );
          return { id, version: row.version + 1, state: 'draft', ...parsed };
        }
        const messageId = randomUUID();
        await tx.execute(
          sql`INSERT INTO demo_messages(tenant_id,id,owner_id,sender_id,message_kind,subject,body,recipient_ids,resource_ref,state) VALUES(${current.tenant_id},${messageId},${current.user_id},${current.user_id},${parsed.message_kind},${parsed.subject},${parsed.body},${JSON.stringify(parsed.recipient_ids)}::jsonb,${JSON.stringify(parsed.resource_ref)}::jsonb,'draft')`,
        );
        return { id: messageId, version: 1, state: 'draft', ...parsed };
      },
    );
  }
  async list(actor: ActorContext, box: 'inbox' | 'sent' = 'inbox') {
    const current = await this.documents.identity.requireCurrentActor(actor);
    const messages =
      box === 'sent'
        ? await rows<MessageRow>(
            this.documents.database.db,
            sql`SELECT * FROM demo_messages WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} ORDER BY created_at DESC,id DESC LIMIT 100`,
          )
        : await rows<MessageRow & { read_at: Date | null }>(
            this.documents.database.db,
            sql`SELECT m.*,d.read_at FROM demo_messages m JOIN message_deliveries d ON d.tenant_id=m.tenant_id AND d.message_id=m.id WHERE d.tenant_id=${current.tenant_id} AND d.recipient_id=${current.user_id} ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,
          );
    return {
      items: messages.map((message) => ({
        ...message,
        channel: '演示站内通知',
      })),
      next_cursor: null,
    };
  }
  async markRead(
    actor: ActorContext,
    id: string,
    version: number,
    key: string,
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    return idempotent(
      this.documents.database,
      current,
      'oa.message.read',
      key,
      { id, version },
      async (tx) => {
        const [delivery] = await rows<{
          version: number;
          read_at: Date | null;
        }>(
          tx,
          sql`SELECT version,read_at FROM message_deliveries WHERE tenant_id=${current.tenant_id} AND message_id=${id} AND recipient_id=${current.user_id} FOR UPDATE`,
        );
        if (!delivery) throw missing();
        if (delivery.read_at)
          return { id, version: delivery.version, read_at: delivery.read_at };
        if (delivery.version !== version) throw conflict();
        const [saved] = await rows<{ version: number; read_at: Date }>(
          tx,
          sql`UPDATE message_deliveries SET read_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND message_id=${id} AND recipient_id=${current.user_id} RETURNING version,read_at`,
        );
        return { id, ...saved };
      },
    );
  }
  handler(): ActionHandler {
    return {
      mode: 'local',
      validate: async (actor, args, refs, tx) => {
        const parsed = SendArgsSchema.parse(args),
          db = tx ?? this.documents.database.db;
        const [draft] = await rows<MessageRow>(
          db,
          sql`SELECT * FROM demo_messages WHERE tenant_id=${actor.tenant_id} AND id=${parsed.message_draft_id} AND owner_id=${actor.user_id} ${tx ? sql`FOR UPDATE` : sql``}`,
        );
        if (!draft) throw missing();
        if (draft.state !== 'draft')
          throw new AppError('INVALID_STATE', '消息已经发送。');
        if (draft.version !== parsed.expected_draft_version) throw conflict();
        if (
          refs.length !== 1 ||
          canonicalJson(refs[0]) !== canonicalJson(draft.resource_ref) ||
          parsed.subject !== draft.subject ||
          parsed.body !== draft.body ||
          canonicalJson(parsed.recipient_ids) !==
            canonicalJson(draft.recipient_ids)
        )
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '消息内容或范围已变化，请重新确认。',
          );
        const document = await this.recipients(
          actor,
          draft.resource_ref,
          draft.recipient_ids,
        );
        if (document.version !== draft.resource_ref.version) throw conflict();
        return {
          summary: {
            action: 'oa.message.send',
            subject: draft.subject,
            body: draft.body,
            recipient_ids: draft.recipient_ids,
            resource_ref: draft.resource_ref,
            channel: '演示站内通知',
          },
          args: parsed,
          items: [
            {
              resource_ref: draft.resource_ref,
              args: parsed,
              guards: { draft_id: draft.id, draft_version: draft.version },
            },
          ],
          extra_guards: { draft_id: draft.id, draft_version: draft.version },
        };
      },
      execute: async (ctx, tx, action) => {
        if (!tx) throw new Error('消息发送需要真实事务。');
        const args = SendArgsSchema.parse(action.args);
        const result = await rows<MessageRow>(
          tx,
          sql`UPDATE demo_messages SET state='sent',sent_at=clock_timestamp(),action_id=${ctx.action_id},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${args.message_draft_id} AND state='draft' AND version=${args.expected_draft_version} RETURNING *`,
        );
        if (!result.length) throw conflict();
        for (const recipient of result[0]!.recipient_ids)
          await tx.execute(
            sql`INSERT INTO message_deliveries(tenant_id,message_id,recipient_id) VALUES(${ctx.actor.tenant_id},${args.message_draft_id},${recipient}) ON CONFLICT DO NOTHING`,
          );
        return this.approvals.receipt(
          ctx,
          action,
          tx,
          action.item.resource_ref!,
        );
      },
      queryOutcome: async (ctx, action) =>
        this.approvals.handler('oa.submit').queryOutcome(ctx, action),
    };
  }
}
