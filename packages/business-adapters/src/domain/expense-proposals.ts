import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import {
  ExpenseDraftSchema,
  ExpenseItemSchema,
  ExpenseProposalInputSchema,
  ExpenseProposalModelSchema,
  ApplyExpenseProposalSchema,
  type ExpenseDraft,
  type ExpenseOperation,
} from '@caixiaozhi/contracts/expenses';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash, canonicalJson } from '@caixiaozhi/platform/hash';
import { enqueueInTransaction, type DurableJob } from '@caixiaozhi/jobs/queue';
import { DocumentService, BusinessDocumentSchemas } from './documents.js';
import { InvoiceService } from './invoices.js';
import {
  rows,
  rawDocument,
  idempotent,
  conflict,
  missing,
  validation,
} from './store.js';
import {
  assertDependencySnapshot,
  assertEvidence,
  assertProposalLease,
  materialGuards,
  readMaterials,
} from './proposal-support.js';
import { validateSubmission } from './validation.js';

export function normalizeExpenseOperations(
  operations: ExpenseOperation[],
  draft: ExpenseDraft,
): ExpenseOperation[] {
  if (new Set(operations.map((op) => op.id)).size !== operations.length)
    throw validation('费用差异标识重复。');
  const mapping = new Map<string, string>();
  const ids = new Set(draft.items.map((item) => item.item_id));
  for (const op of operations)
    if (op.kind === 'insert_item') {
      if (ids.has(op.temporary_item_key) || mapping.has(op.temporary_item_key))
        throw validation('新增费用临时标识必须唯一。');
      mapping.set(op.temporary_item_key, randomUUID());
    }
  return operations.map((op) =>
    op.kind === 'insert_item'
      ? {
          ...op,
          after_item_id:
            op.after_item_id === null
              ? null
              : (mapping.get(op.after_item_id) ?? op.after_item_id),
          item: { ...op.item, item_id: mapping.get(op.temporary_item_key)! },
        }
      : op.kind === 'replace_item'
        ? { ...op, item_id: mapping.get(op.item_id) ?? op.item_id }
        : op,
  );
}
export function applyExpenseOperations(
  source: ExpenseDraft,
  operations: ExpenseOperation[],
  selectedInvoices: Array<{ id: string; version: number }>,
): ExpenseDraft {
  const draft = structuredClone(source);
  for (const op of operations) {
    if (op.kind === 'replace_claim') {
      if (canonicalJson(draft[op.field]) !== canonicalJson(op.old))
        throw conflict();
      Object.assign(draft, { [op.field]: op.new });
    } else if (op.kind === 'insert_item') {
      if (
        !selectedInvoices.some(
          (invoice) =>
            invoice.id === op.item.invoice_id &&
            invoice.version === op.item.invoice_version,
        )
      )
        throw validation('新增费用只能引用本轮明确选择的已确认票据。');
      if (draft.items.some((item) => item.item_id === op.item.item_id))
        throw conflict();
      const after =
        op.after_item_id === null
          ? -1
          : draft.items.findIndex((item) => item.item_id === op.after_item_id);
      if (op.after_item_id !== null && after < 0)
        throw validation('新增费用依赖的前序费用未被采纳。');
      draft.items.splice(after + 1, 0, ExpenseItemSchema.parse(op.item));
    } else if (op.kind === 'delete_item') {
      const index = draft.items.findIndex(
        (item) => item.item_id === op.item_id,
      );
      if (
        index < 0 ||
        canonicalJson(draft.items[index]) !== canonicalJson(op.old)
      )
        throw conflict();
      draft.items.splice(index, 1);
    } else {
      const item = draft.items.find((item) => item.item_id === op.item_id);
      if (!item || canonicalJson(item[op.field]) !== canonicalJson(op.old))
        throw conflict();
      Object.assign(item, { [op.field]: op.new });
      if (op.field === 'expense_type' || op.field === 'expense_subtype')
        item.type_confirmation = 'confirmed';
    }
  }
  return ExpenseDraftSchema.parse(draft);
}
export class ExpenseProposalService {
  constructor(
    readonly documents: DocumentService,
    readonly invoices: InvoiceService,
  ) {}
  private async invoiceSnapshots(
    actor: ActorContext,
    claimId: string,
    refs: Array<{ id: string; version: number }>,
    tx: DatabaseExecutor = this.documents.database.db,
  ) {
    const result: Array<{
      id: string;
      version: number;
      file_id: string;
      file_version: number;
      sha256: string;
      fields: unknown;
      fields_hash: string;
    }> = [];
    for (const ref of refs) {
      const invoice = await this.invoices.get(actor, ref.id);
      if (
        invoice.owner_id !== actor.user_id ||
        invoice.version !== ref.version ||
        invoice.confirmation_state !== 'confirmed'
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '请选择当前版本、已明确确认的本人票据。',
        );
      const [reservation] = await rows<{ claim_id: string }>(
        tx,
        sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${actor.tenant_id} AND invoice_id=${ref.id}`,
      );
      if (reservation && reservation.claim_id !== claimId)
        throw validation('该票据可能已使用，请联系财务核实。');
      const { file } = await this.invoices.files.readFile(
        actor,
        invoice.file_id as string,
      );
      if (!file.sha256) throw validation('票据文件尚未完成校验。');
      result.push({
        id: ref.id,
        version: ref.version,
        file_id: file.id,
        file_version: file.version,
        sha256: file.sha256,
        fields: invoice.fields,
        fields_hash: canonicalHash(invoice.fields),
      });
    }
    return result;
  }
  private guards(
    materials: Awaited<ReturnType<typeof readMaterials>>,
    invoices: Awaited<ReturnType<ExpenseProposalService['invoiceSnapshots']>>,
  ) {
    return {
      materials: materialGuards(materials),
      invoices: invoices.map(({ fields, ...guard }) => guard),
    };
  }
  async create(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
    originRunId: string | null = null,
  ) {
    const parsed = ExpenseProposalInputSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertResourceAccess(
      current,
      'expense.write.own',
      { type: 'expense_claim', id, version: parsed.expected_version },
    );
    const materials = await readMaterials(
      this.documents,
      current,
      parsed.selected_material_refs,
    );
    const invoices = await this.invoiceSnapshots(
      current,
      id,
      parsed.invoice_refs,
    );
    const generation = (await this.documents.identity.getMe(current))
      .generation;
    return idempotent(
      this.documents.database,
      current,
      'expense.propose',
      key,
      { id, ...parsed },
      async (tx) => {
        const head = await rawDocument(tx, current, 'expense_claim', id, true);
        if (head.version !== parsed.expected_version) throw conflict();
        if (!['draft', 'returned', 'withdrawn'].includes(head.state))
          throw new AppError('INVALID_STATE', '当前报销不能生成草稿差异。');
        const source = await this.documents.project(tx, 'expense_claim', head);
        const taskId = randomUUID();
        await tx.execute(
          sql`INSERT INTO expense_proposal_tasks(tenant_id,id,owner_id,claim_id,base_version,prompt,selected_material_refs,invoice_refs,actor_context,source_snapshot,dependency_snapshot,origin_run_id,state) VALUES(${current.tenant_id},${taskId},${current.user_id},${id},${head.version},${parsed.prompt},${JSON.stringify(parsed.selected_material_refs)}::jsonb,${JSON.stringify(parsed.invoice_refs)}::jsonb,${JSON.stringify(current)}::jsonb,${JSON.stringify(source)}::jsonb,${JSON.stringify(this.guards(materials, invoices))}::jsonb,${originRunId},'queued')`,
        );
        const job = await (
          this.documents.options.enqueueDomainJob ?? enqueueInTransaction
        )(tx, {
          tenant_id: current.tenant_id,
          owner_module: 'expenses',
          kind: 'expense.proposal',
          payload_ref: taskId,
          dedupe_key: taskId,
          generation,
        });
        await tx.execute(
          sql`UPDATE expense_proposal_tasks SET job_id=${job.id} WHERE tenant_id=${current.tenant_id} AND id=${taskId}`,
        );
        return {
          task_id: taskId,
          proposal_id: taskId,
          job_id: job.id,
          origin_run_id: originRunId,
          status: 'queued',
          base_version: head.version,
        };
      },
    );
  }
  async get(actor: ActorContext, claimId: string, id: string) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.get(current, 'expense_claim', claimId);
    const [proposal] = await rows<any>(
      this.documents.database.db,
      sql`SELECT * FROM expense_proposals WHERE tenant_id=${current.tenant_id} AND id=${id} AND claim_id=${claimId} AND owner_id=${current.user_id}`,
    );
    if (proposal)
      return {
        id: proposal.id,
        base_version: proposal.base_version,
        status: proposal.state,
        operations: proposal.operations,
        clarifications: proposal.clarifications,
        selected_material_refs: proposal.selected_material_refs,
        invoice_refs: proposal.invoice_refs,
        applied_operation_ids: proposal.applied_operation_ids,
        requires_review: true,
      };
    const [task] = await rows<any>(
      this.documents.database.db,
      sql`SELECT id,base_version,state,error_code,origin_run_id FROM expense_proposal_tasks WHERE tenant_id=${current.tenant_id} AND id=${id} AND claim_id=${claimId} AND owner_id=${current.user_id}`,
    );
    if (!task) throw missing();
    return {
      ...task,
      status: task.state,
      operations: [],
      clarifications: [],
      requires_review: true,
    };
  }
  async processJob(job: DurableJob) {
    await assertProposalLease(this.documents.database.db, job);
    const [task] = await rows<any>(
      this.documents.database.db,
      sql`SELECT * FROM expense_proposal_tasks WHERE tenant_id=${job.tenant_id} AND id=${job.payload_ref}`,
    );
    if (!task) throw missing();
    if (task.state === 'completed') return;
    try {
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        await tx.execute(
          sql`UPDATE expense_proposal_tasks SET state='running',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
      });
      if (!this.documents.options.proposeExpense)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '报销语义建议需要配置真实模型。',
        );
      const actor = await this.documents.identity.requireCurrentActor(
          task.actor_context,
        ),
        current = await this.documents.get(
          actor,
          'expense_claim',
          task.claim_id,
        );
      if (current.version !== task.base_version)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '报销已更新，请基于新版本重新生成建议。',
        );
      const materials = await readMaterials(
          this.documents,
          actor,
          task.selected_material_refs,
        ),
        invoices = await this.invoiceSnapshots(
          actor,
          task.claim_id,
          task.invoice_refs,
        );
      assertDependencySnapshot(
        this.guards(materials, invoices),
        task.dependency_snapshot,
      );
      const generated = ExpenseProposalModelSchema.parse(
        await this.documents.options.proposeExpense({
          actor,
          document: BusinessDocumentSchemas.expense_claim.parse(
            task.source_snapshot,
          ),
          prompt: task.prompt,
          material_refs: materials,
          invoice_snapshots: invoices,
        }),
      );
      assertEvidence(generated.operations, materials, task.invoice_refs);
      const source = ExpenseDraftSchema.parse(
        Object.fromEntries(
          Object.keys(ExpenseDraftSchema.shape).map((field) => [
            field,
            task.source_snapshot[field],
          ]),
        ),
      );
      const operations = normalizeExpenseOperations(
        generated.operations,
        source,
      );
      applyExpenseOperations(source, operations, task.invoice_refs);
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        const head = await rawDocument(
          tx,
          actor,
          'expense_claim',
          task.claim_id,
          true,
        );
        const finalMaterials = await readMaterials(
            this.documents,
            actor,
            task.selected_material_refs,
          ),
          finalInvoices = await this.invoiceSnapshots(
            actor,
            task.claim_id,
            task.invoice_refs,
            tx,
          );
        const dependencies = this.guards(finalMaterials, finalInvoices);
        const fresh =
          head.version === task.base_version &&
          canonicalJson(dependencies) ===
            canonicalJson(task.dependency_snapshot);
        await tx.execute(
          sql`INSERT INTO expense_proposals(tenant_id,id,owner_id,claim_id,base_version,state,operations,clarifications,selected_material_refs,invoice_refs,source_snapshot,dependency_snapshot) VALUES(${actor.tenant_id},${task.id},${actor.user_id},${task.claim_id},${task.base_version},${fresh ? 'proposed' : 'stale'},${JSON.stringify(operations)}::jsonb,${JSON.stringify(generated.clarifications)}::jsonb,${JSON.stringify(task.selected_material_refs)}::jsonb,${JSON.stringify(task.invoice_refs)}::jsonb,${JSON.stringify(task.source_snapshot)}::jsonb,${JSON.stringify(dependencies)}::jsonb) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`UPDATE expense_proposal_tasks SET state='completed',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${actor.tenant_id} AND id=${task.id}`,
        );
      });
    } catch (error) {
      if (error instanceof AppError && error.details?.reason === 'LEASE_LOST')
        throw error;
      await this.documents.database.db.transaction(async (tx) => {
        await assertProposalLease(tx, job);
        await tx.execute(
          sql`UPDATE expense_proposal_tasks SET state='failed',error_code=${error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE'},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${job.tenant_id} AND id=${task.id}`,
        );
      });
      throw error;
    }
  }
  async apply(
    actor: ActorContext,
    claimId: string,
    id: string,
    input: unknown,
    key: string,
  ) {
    const parsed = ApplyExpenseProposalSchema.parse(input),
      current = await this.documents.identity.requireCurrentActor(actor);
    await this.documents.identity.assertResourceAccess(
      current,
      'expense.write.own',
      { type: 'expense_claim', id: claimId, version: parsed.expected_version },
    );
    return idempotent(
      this.documents.database,
      current,
      'expense.proposal.apply',
      key,
      { id, claimId, ...parsed },
      async (tx) => {
        const head = await rawDocument(
          tx,
          current,
          'expense_claim',
          claimId,
          true,
        );
        if (head.version !== parsed.expected_version) throw conflict();
        const [proposal] = await rows<any>(
          tx,
          sql`SELECT * FROM expense_proposals WHERE tenant_id=${current.tenant_id} AND id=${id} AND claim_id=${claimId} AND owner_id=${current.user_id} FOR UPDATE`,
        );
        if (!proposal) throw missing();
        if (
          proposal.base_version !== parsed.expected_version ||
          proposal.state !== 'proposed'
        )
          throw conflict();
        const materials = await readMaterials(
            this.documents,
            current,
            proposal.selected_material_refs,
          ),
          invoices = await this.invoiceSnapshots(
            current,
            claimId,
            proposal.invoice_refs,
            tx,
          );
        assertDependencySnapshot(
          this.guards(materials, invoices),
          proposal.dependency_snapshot,
        );
        if (
          new Set(parsed.selected_operation_ids).size !==
            parsed.selected_operation_ids.length ||
          parsed.selected_operation_ids.some(
            (selected) =>
              !proposal.operations.some(
                (op: ExpenseOperation) => op.id === selected,
              ),
          )
        )
          throw validation('所选差异不属于本次提议或包含重复项。');
        const currentDocument = await this.documents.project(
            tx,
            'expense_claim',
            head,
          ),
          source = ExpenseDraftSchema.parse(
            Object.fromEntries(
              Object.keys(ExpenseDraftSchema.shape).map((field) => [
                field,
                currentDocument[field as keyof typeof currentDocument],
              ]),
            ),
          );
        const combined = applyExpenseOperations(
          source,
          (proposal.operations as ExpenseOperation[]).filter((op) =>
            parsed.selected_operation_ids.includes(op.id),
          ),
          proposal.invoice_refs,
        );
        const saved = await this.documents.saveExpense(
          current,
          claimId,
          { ...combined, expected_version: parsed.expected_version },
          key,
          tx,
        );
        const report = await validateSubmission(
          this.documents,
          current,
          { type: 'expense_claim', id: claimId, version: saved.version },
          tx,
        );
        const blocking = report.errors.filter(
          (error) =>
            error.path.startsWith('items.') &&
            (error.code.startsWith('OA_') ||
              error.code.startsWith('TRAVEL_') ||
              [
                'INVOICE_VERSION_CHANGED',
                'TYPE_UNCONFIRMED',
                'AMOUNT_MISMATCH',
              ].includes(error.code) ||
              error.path.endsWith('lodging_details')),
        );
        if (blocking.length)
          throw validation(
            '所选差异造成费用关联或明细不完整，请核对需要同时采纳的项目。',
            blocking,
          );
        await tx.execute(
          sql`UPDATE expense_proposals SET state='applied',applied_operation_ids=${JSON.stringify(parsed.selected_operation_ids)}::jsonb,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
        );
        return saved;
      },
    );
  }
}
