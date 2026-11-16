import { createHmac, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import {
  InvoiceFieldsSchema,
  InvoiceConfirmationSchema,
  InvoiceCorrectionSchema,
  type InvoiceFields,
} from '@caixiaozhi/contracts/expenses';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  createDurableQueue,
  enqueueInTransaction,
  type DurableJob,
} from '@caixiaozhi/jobs/queue';
import { DocumentService } from './documents.js';
import {
  rows,
  idempotent,
  rawDocument,
  conflict,
  missing,
  validation,
  recordDocumentEvent,
} from './store.js';

export type InvoiceFilesPort = {
  readFile(
    actor: ActorContext,
    id: string,
  ): Promise<{
    file: {
      id: string;
      version: number;
      status: string;
      sha256: string | null;
      owner_id: string;
      profile: string;
    };
    bytes: Uint8Array;
  }>;
  bindParent(
    actor: ActorContext,
    id: string,
    ref: { type: 'expense_claim'; id: string; version: number },
  ): Promise<unknown>;
};
export type InvoiceRecord = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  owner_id: string;
  file_id: string;
  version: number;
  fields: InvoiceFields;
  confirmation_state: 'recognized' | 'needs_confirmation' | 'confirmed';
  verification_state: 'pending' | 'verified' | 'rejected' | 'unavailable';
  created_at: string;
  updated_at: string;
};
export type InvoiceOptions = {
  beforeOcr?: (
    actor: ActorContext,
    fileId: string,
    sha256: string,
  ) => Promise<void>;
  transformCandidates?: (
    actor: ActorContext,
    fileId: string,
    sha256: string,
    candidates: InvoiceFields[],
  ) => Promise<InvoiceFields[]>;
};
export class InvoiceService {
  readonly queue;
  constructor(
    readonly documents: DocumentService,
    readonly files: InvoiceFilesPort,
    readonly fingerprintSecret: string,
    readonly appMode: 'demo' | 'test' | 'production',
    readonly options: InvoiceOptions = {},
  ) {
    this.queue = createDurableQueue(documents.database);
  }
  async get(actor: ActorContext, id: string): Promise<InvoiceRecord> {
    const current = await this.documents.identity.requireCurrentActor(actor);
    const [invoice] = await rows<InvoiceRecord>(
      this.documents.database.db,
      sql`SELECT * FROM invoices WHERE tenant_id=${current.tenant_id} AND id=${id}`,
    );
    if (!invoice) throw missing();
    if (invoice.owner_id !== current.user_id) {
      const [reservation] = await rows<{ claim_id: string }>(
        this.documents.database.db,
        sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND invoice_id=${id}`,
      );
      if (!reservation) throw missing();
      await this.documents.get(current, 'expense_claim', reservation.claim_id);
    }
    return {
      ...invoice,
      fields: InvoiceFieldsSchema.parse(invoice.fields),
      created_at: new Date(invoice.created_at as string).toISOString(),
      updated_at: new Date(invoice.updated_at as string).toISOString(),
      fingerprint: undefined,
    };
  }
  async list(
    actor: ActorContext,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertPermission(current, 'expense.read.own');
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const result = await rows<{ id: string }>(
      this.documents.database.db,
      sql`SELECT id FROM invoices WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} ${input.cursor ? sql`AND id>${input.cursor}` : sql``} ORDER BY id LIMIT ${limit + 1}`,
    );
    return {
      items: await Promise.all(
        result.slice(0, limit).map((item) => this.get(current, item.id)),
      ),
      next_cursor: result.length > limit ? result[limit - 1]!.id : null,
    };
  }
  async createOcr(
    actor: ActorContext,
    input: { file_id: string; file_version: number },
    key: string,
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertPermission(
      current,
      'expense.write.own',
    );
    const { file } = await this.files.readFile(current, input.file_id);
    if (
      file.owner_id !== current.user_id ||
      file.profile !== 'invoice-v1' ||
      file.status !== 'validated'
    )
      throw validation('请选择已完成校验的本人票据文件。');
    if (file.version !== input.file_version) throw conflict();
    if (!file.sha256) throw validation('文件校验摘要缺失。');
    const generation = (await this.documents.identity.getMe(current))
      .generation;
    return idempotent(
      this.documents.database,
      current,
      'expense.ocr.create',
      key,
      input,
      async (tx) => {
        const [existing] = await rows<{
          id: string;
          state: string;
          attempt: number;
        }>(
          tx,
          sql`SELECT id,state,attempt FROM ocr_tasks WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND file_id=${file.id} AND file_version=${file.version} AND provider_version='demo-ocr-v1' FOR UPDATE`,
        );
        if (existing && existing.state !== 'failed')
          return {
            task_id: existing.id,
            status: existing.state,
            provider_mode: 'demo',
          };
        if (existing && existing.attempt >= 3)
          throw new AppError(
            'INVALID_STATE',
            '识别重试次数已达上限，请人工核对或重新上传。',
          );
        const id = existing?.id ?? randomUUID();
        if (existing)
          await tx.execute(
            sql`UPDATE ocr_tasks SET state='queued',error_code=NULL,actor_context=${JSON.stringify(current)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
          );
        else
          await tx.execute(
            sql`INSERT INTO ocr_tasks(tenant_id,id,owner_id,file_id,file_version,sha256,provider_version,state,generation,actor_context) VALUES(${current.tenant_id},${id},${current.user_id},${file.id},${file.version},${file.sha256},'demo-ocr-v1','queued',${generation},${JSON.stringify(current)}::jsonb)`,
          );
        const job = await enqueueInTransaction(tx, {
          tenant_id: current.tenant_id,
          owner_module: 'expenses',
          kind: 'expense.ocr',
          payload_ref: id,
          dedupe_key: `${id}:${(existing?.attempt ?? 0) + 1}`,
          generation,
        });
        return {
          task_id: id,
          job_id: job.id,
          status: 'queued',
          provider_mode: 'demo',
        };
      },
    );
  }
  async getTask(actor: ActorContext, id: string) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    const [task] = await rows<{
      id: string;
      state: string;
      attempt: number;
      invoice_ids: string[];
      error_code: string | null;
      version: number;
    }>(
      this.documents.database.db,
      sql`SELECT id,state,attempt,invoice_ids,error_code,version FROM ocr_tasks WHERE tenant_id=${current.tenant_id} AND owner_id=${current.user_id} AND id=${id}`,
    );
    if (!task) throw missing();
    return {
      ...task,
      provider_mode: 'demo',
      invoices: await Promise.all(
        task.invoice_ids.map((invoiceId) => this.get(current, invoiceId)),
      ),
    };
  }
  async processJob(job: DurableJob) {
    const [task] = await rows<{
      owner_id: string;
      file_id: string;
      file_version: number;
      sha256: string;
      state: string;
      actor_context: ActorContext;
      generation: number;
    }>(
      this.documents.database.db,
      sql`SELECT * FROM ocr_tasks WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref}`,
    );
    if (!task) throw missing();
    if (task.state === 'completed') return;
    await this.documents.database.db.execute(
      sql`UPDATE ocr_tasks SET state='running',attempt=attempt+1,lease_epoch=${job.lease_epoch},lease_owner=${job.lease_owner},lease_until=clock_timestamp()+interval '30 seconds',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref}`,
    );
    try {
      if (this.appMode === 'production')
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '正式票据识别提供方尚未配置。',
        );
      const current = await this.documents.identity.requireCurrentActor(
        task.actor_context,
      );
      const { file } = await this.files.readFile(current, task.file_id);
      if (file.version !== task.file_version || file.sha256 !== task.sha256)
        throw new AppError('REVALIDATION_REQUIRED', '识别输入文件已变化。');
      await this.options.beforeOcr?.(current, task.file_id, task.sha256);
      const [fixture] = await rows<{ candidates: unknown[] }>(
        this.documents.database.db,
        sql`SELECT candidates FROM demo_ocr_fixtures WHERE tenant_id=${job.tenant_id} AND sha256=${task.sha256} AND provider_version='demo-ocr-v1' AND synthetic=true`,
      );
      if (!fixture)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '当前演示识别提供方没有该文件的已登记样本，请选择人工录入。',
        );
      const parsedCandidates = z
        .array(InvoiceFieldsSchema)
        .min(1)
        .max(100)
        .parse(fixture.candidates);
      const candidates = z
        .array(InvoiceFieldsSchema)
        .min(1)
        .max(100)
        .parse(
          this.options.transformCandidates
            ? await this.options.transformCandidates(
                current,
                task.file_id,
                task.sha256,
                parsedCandidates,
              )
            : parsedCandidates,
        );
      await this.documents.database.db.transaction(async (tx) => {
        const [locked] = await rows<{
          state: string;
          lease_epoch: number;
          generation: number;
        }>(
          tx,
          sql`SELECT state,lease_epoch,generation FROM ocr_tasks WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref} FOR UPDATE`,
        );
        if (
          locked?.lease_epoch !== job.lease_epoch ||
          locked.generation !== job.generation
        )
          throw new AppError(
            'INVALID_STATE',
            '识别任务租约或演示数据代次已失效。',
          );
        const ids: string[] = [];
        for (const fields of candidates) {
          const id = randomUUID();
          ids.push(id);
          await tx.execute(
            sql`INSERT INTO invoices(tenant_id,id,owner_id,file_id,fields,confirmation_state,verification_state,gross_minor,source_fields,verification_evidence) VALUES(${job.tenant_id},${id},${task.owner_id},${task.file_id},${JSON.stringify(fields)}::jsonb,'needs_confirmation','pending',${fields.gross_amount?.amount_minor ?? null},${JSON.stringify({ provider: 'demo-ocr-v1', file_sha256: task.sha256, synthetic: true })}::jsonb,${JSON.stringify({ provider: 'demo-verification', synthetic: true, state: 'pending' })}::jsonb)`,
          );
        }
        await tx.execute(
          sql`UPDATE ocr_tasks SET state='completed',invoice_ids=${JSON.stringify(ids)}::jsonb,lease_until=NULL,lease_owner=NULL,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref} AND lease_epoch=${job.lease_epoch}`,
        );
      });
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
      await this.documents.database.db.execute(
        sql`UPDATE ocr_tasks SET state='failed',error_code=${code},lease_until=NULL,lease_owner=NULL,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref} AND lease_epoch=${job.lease_epoch}`,
      );
      throw error;
    }
  }
  async createManual(
    actor: ActorContext,
    input: { file_id: string; file_version: number },
    key: string,
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertPermission(
      current,
      'expense.write.own',
    );
    const { file } = await this.files.readFile(current, input.file_id);
    if (
      file.owner_id !== current.user_id ||
      file.profile !== 'invoice-v1' ||
      file.status !== 'validated' ||
      file.version !== input.file_version
    )
      throw validation('请先上传并验证本人票据文件。');
    const fields: InvoiceFields = {
      invoice_number: null,
      invoice_code: null,
      invoice_date: null,
      seller_name: null,
      buyer_name: null,
      seller_tax_id: null,
      buyer_tax_id: null,
      gross_amount: null,
      tax_amount: null,
      net_amount: null,
      invoice_kind: 'other',
      expense_type: null,
    };
    return idempotent(
      this.documents.database,
      current,
      'expense.invoice.manual',
      key,
      input,
      async (tx) => {
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO invoices(tenant_id,id,owner_id,file_id,fields,confirmation_state,verification_state,source_fields) VALUES(${current.tenant_id},${id},${current.user_id},${file.id},${JSON.stringify(fields)}::jsonb,'needs_confirmation','pending',${JSON.stringify({ source: 'manual', file_sha256: file.sha256 })}::jsonb)`,
        );
        return {
          id,
          version: 1,
          confirmation_state: 'needs_confirmation',
          fields,
        };
      },
    );
  }
  async patch(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ): Promise<InvoiceRecord> {
    const parsed = InvoiceCorrectionSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertPermission(
      current,
      'expense.write.own',
    );
    return idempotent(
      this.documents.database,
      current,
      'expense.invoice.correct',
      key,
      { id, ...parsed },
      async (tx) => {
        const [invoice] = await rows<{
          owner_id: string;
          version: number;
          fields: InvoiceFields;
          corrections: unknown[];
        }>(
          tx,
          sql`SELECT owner_id,version,fields,corrections FROM invoices WHERE tenant_id=${current.tenant_id} AND id=${id} FOR UPDATE`,
        );
        if (!invoice || invoice.owner_id !== current.user_id) throw missing();
        if (invoice.version !== parsed.expected_version) throw conflict();
        const fields = InvoiceFieldsSchema.parse({
          ...invoice.fields,
          ...parsed.corrections,
        });
        const [bound] = await rows<{ claim_id: string }>(
          tx,
          sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND invoice_id=${id}`,
        );
        if (bound) {
          const claim = await rawDocument(
            tx,
            current,
            'expense_claim',
            bound.claim_id,
            true,
          );
          if (!['draft', 'returned', 'withdrawn'].includes(claim.state))
            throw new AppError(
              'INVALID_STATE',
              '审批中或已完成的票据不能修改，请先按业务流程退回或撤回。',
            );
          await tx.execute(
            sql`UPDATE expense_claims SET version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${bound.claim_id}`,
          );
          await tx.execute(
            sql`UPDATE expense_proposals SET state='stale',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND claim_id=${bound.claim_id} AND state='proposed'`,
          );
          await recordDocumentEvent(
            tx,
            current,
            'expense_claim',
            bound.claim_id,
            claim.version + 1,
            'expense.material_updated',
          );
        }
        const corrections = [
          ...invoice.corrections,
          {
            kind: 'correction',
            before: invoice.fields,
            after: fields,
            changed_fields: Object.keys(parsed.corrections),
            reason: parsed.reason,
            edited_by: current.user_id,
            edited_at: new Date().toISOString(),
          },
        ];
        const [updated] = await rows<InvoiceRecord>(
          tx,
          sql`UPDATE invoices SET fields=${JSON.stringify(fields)}::jsonb,gross_minor=${fields.gross_amount?.amount_minor ?? null},confirmation_state='needs_confirmation',verification_state='pending',verification_evidence=NULL,fingerprint=NULL,corrections=${JSON.stringify(corrections)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id} RETURNING *`,
        );
        if (!updated) throw missing();
        return {
          ...updated,
          fields,
          fingerprint: undefined,
          created_at: new Date(updated.created_at).toISOString(),
          updated_at: new Date(updated.updated_at).toISOString(),
        };
      },
    );
  }
  async confirm(actor: ActorContext, id: string, input: unknown, key: string) {
    const parsed = InvoiceConfirmationSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertPermission(
      current,
      'expense.write.own',
    );
    const fields = { ...parsed.fields, expense_type: parsed.expense_type };
    if (
      !fields.invoice_number ||
      !fields.invoice_date ||
      !fields.seller_name ||
      !fields.buyer_name ||
      !fields.gross_amount ||
      fields.tax_amount === null
    )
      throw validation('请补齐票据号码、日期、购销方及金额。');
    if (fields.invoice_date > (await this.documents.businessDate()))
      throw validation('票据日期不能晚于业务日期。');
    if (
      BigInt(fields.tax_amount.amount_minor) >
        BigInt(fields.gross_amount.amount_minor) ||
      (fields.net_amount &&
        BigInt(fields.net_amount.amount_minor) +
          BigInt(fields.tax_amount.amount_minor) !==
          BigInt(fields.gross_amount.amount_minor))
    )
      throw validation('票据净额、税额与价税合计不一致。');
    const normalized = [
      fields.invoice_kind,
      fields.invoice_code ?? '',
      fields.invoice_number,
      fields.seller_tax_id ?? fields.seller_name,
      fields.invoice_date,
      fields.gross_amount.amount_minor,
    ].join('|');
    const fingerprint = createHmac('sha256', this.fingerprintSecret)
      .update(normalized)
      .digest('hex');
    return idempotent(
      this.documents.database,
      current,
      'expense.invoice.confirm',
      key,
      { id, ...parsed },
      async (tx) => {
        const [invoice] = await rows<{
          owner_id: string;
          version: number;
          fields: unknown;
          file_id: string;
          corrections: unknown[];
          confirmation_state: string;
        }>(
          tx,
          sql`SELECT owner_id,version,fields,file_id,corrections,confirmation_state FROM invoices WHERE tenant_id=${current.tenant_id} AND id=${id} FOR UPDATE`,
        );
        if (!invoice || invoice.owner_id !== current.user_id) throw missing();
        if (invoice.version !== parsed.expected_version) throw conflict();
        if (invoice.confirmation_state === 'confirmed')
          throw new AppError(
            'INVALID_STATE',
            '票据已确认；修改票面请先保存矫正，再重新确认。',
          );
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.tenant_id + ':' + fingerprint},0))`,
        );
        const duplicate = await rows<{ id: string }>(
          tx,
          sql`SELECT i.id FROM invoices i JOIN invoice_reservations r ON r.tenant_id=i.tenant_id AND r.invoice_id=i.id WHERE i.tenant_id=${current.tenant_id} AND i.fingerprint=${fingerprint} AND i.id<>${id} LIMIT 1`,
        );
        if (duplicate.length)
          throw validation('该票据可能已使用，请联系财务核实。', [
            { code: 'DUPLICATE_INVOICE', path: 'fields.invoice_number' },
          ]);
        const [bound] = await rows<{ claim_id: string }>(
          tx,
          sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND invoice_id=${id}`,
        );
        if (bound) {
          const claim = await rawDocument(
            tx,
            current,
            'expense_claim',
            bound.claim_id,
            true,
          );
          if (!['draft', 'returned', 'withdrawn'].includes(claim.state))
            throw new AppError(
              'INVALID_STATE',
              '审批中或已完成的票据不能直接修改。',
            );
          await tx.execute(
            sql`UPDATE expense_claims SET version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${bound.claim_id}`,
          );
          await recordDocumentEvent(
            tx,
            current,
            'expense_claim',
            bound.claim_id,
            claim.version + 1,
            'expense.material_updated',
          );
        }
        const corrections = [
          ...invoice.corrections,
          {
            before: invoice.fields,
            after: fields,
            edited_by: current.user_id,
            edited_at: new Date().toISOString(),
          },
        ];
        const [verification] =
          this.appMode === 'production'
            ? []
            : await rows<{ verified: boolean | null }>(
                tx,
                sql`SELECT v.verified FROM demo_verification_fixtures v JOIN uploaded_files f ON f.tenant_id=v.tenant_id AND f.sha256=v.sha256 WHERE f.tenant_id=${current.tenant_id} AND f.id=${invoice.file_id} AND v.provider_version='demo-tax-v1' AND v.synthetic=true`,
              );
        const verificationState =
          verification?.verified === true
            ? 'verified'
            : verification?.verified === false
              ? 'rejected'
              : 'pending';
        await tx.execute(
          sql`UPDATE invoices SET verification_state=${verificationState},verification_evidence=${JSON.stringify({ provider: 'demo-tax-v1', synthetic: this.appMode !== 'production', verified: verification?.verified ?? null, checked_at: new Date().toISOString() })}::jsonb,fields=${JSON.stringify(fields)}::jsonb,confirmation_state='confirmed',gross_minor=${fields.gross_amount!.amount_minor},fingerprint=${fingerprint},corrections=${JSON.stringify(corrections)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
        );
        return {
          id,
          version: invoice.version + 1,
          fields,
          confirmation_state: 'confirmed',
          verification_state: verificationState,
        };
      },
    );
  }
}
