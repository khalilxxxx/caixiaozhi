import { sql } from 'drizzle-orm';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  SrsInputSchema,
  SrsInputSnapshotSchema,
  type SrsInput,
} from '@caixiaozhi/contracts/rules';
import {
  ExpenseItemSchema,
  InvoiceFieldsSchema,
} from '@caixiaozhi/contracts/expenses';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import { DocumentService } from './documents.js';
import { rawDocument, rows, money, conflict } from './store.js';
import { businessDaysBetween } from './calculations.js';

export async function getPreauditInput(
  service: DocumentService,
  actor: ActorContext,
  id: string,
  version: number,
  executor?: DatabaseExecutor,
) {
  const current = await service.identity.requireCurrentActor(actor);
  await service.identity.assertResourceAccess(current, 'expense.read', {
    type: 'expense_claim',
    id,
    version,
  });
  const read = async (db: DatabaseExecutor) => {
    const head = await rawDocument(db, current, 'expense_claim', id);
    if (head.version !== version) throw conflict();
    const itemRows = await rows<{ data: unknown }>(
      db,
      sql`SELECT data FROM expense_items WHERE tenant_id=${current.tenant_id} AND claim_id=${id} ORDER BY id`,
    );
    const items = itemRows.map((row) => ExpenseItemSchema.parse(row.data));
    const invoiceRows = await rows<{
      id: string;
      version: number;
      fields: unknown;
      verification_state: string;
      file_id: string;
      file_version: number;
    }>(
      db,
      sql`SELECT i.id,i.version,i.fields,i.verification_state,i.file_id,f.version AS file_version FROM invoices i JOIN uploaded_files f ON f.tenant_id=i.tenant_id AND f.id=i.file_id JOIN expense_items e ON e.tenant_id=i.tenant_id AND e.invoice_id=i.id WHERE e.tenant_id=${current.tenant_id} AND e.claim_id=${id} ORDER BY i.id`,
    );
    const invoices = invoiceRows.map((row) => ({
      ...row,
      fields: InvoiceFieldsSchema.parse(row.fields),
    }));
    const externalRefs: ResourceRef[] = [];
    const externalFacts: SrsInput['external_facts'] = {};
    const oaStates: boolean[] = [];
    const fieldStates: SrsInput['field_states'] = {};
    for (const invoice of invoices)
      if (['pending', 'unavailable'].includes(invoice.verification_state))
        fieldStates[`invoices.${invoice.id}.verified`] = {
          state: 'unavailable',
          reason:
            invoice.verification_state === 'pending'
              ? 'VERIFICATION_PENDING'
              : 'VERIFICATION_UNAVAILABLE',
        };
    for (const item of items)
      if (item.oa_ref) {
        const oa = await rawDocument(db, current, 'oa_request', item.oa_ref.id);
        externalRefs.push({
          type: 'oa_request',
          id: oa.id,
          version: oa.version,
        });
        oaStates.push(oa.state === 'approved');
        externalFacts[`oa_approved:${item.item_id}`] = {
          value: oa.state === 'approved',
          provenance: `oa:${oa.id}@${oa.version}`,
          state: 'known',
        };
      }
    const hasMeals = items.some((item) => item.expense_type === 'meals');
    externalFacts.oa_approved = {
      value: hasMeals
        ? items
            .filter((item) => item.expense_type === 'meals')
            .every((item) => item.oa_ref !== null) && oaStates.every(Boolean)
        : true,
      provenance: 'authorized-oa-transaction-snapshot',
      state: 'known',
    };
    const businessDate = head.submitted_at
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
          new Date(head.submitted_at),
        )
      : await service.businessDate();
    const input = SrsInputSchema.parse({
      schema_version: 1,
      document: { type: 'expense_claim', id, version },
      business_date: businessDate,
      applicant_id: head.owner_id,
      department_id: head.department_id,
      total_amount: money(head.total_minor),
      expense_items: items.map((item) => ({
        id: item.item_id,
        category:
          item.expense_type === 'office' || item.expense_type === 'other'
            ? 'general'
            : item.expense_type,
        source_expense_type: item.expense_type,
        amount: item.claim_amount,
        invoice_refs: [item.invoice_id],
        spent_on: item.incurred_date,
        room_nights: item.lodging_details
          ? (
              businessDaysBetween(
                item.lodging_details.check_in,
                item.lodging_details.check_out,
              ) * Number(item.lodging_details.room_count)
            ).toString()
          : null,
        oa_request_ref: item.oa_ref,
      })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        amount: invoice.fields.gross_amount,
        invoice_number: invoice.fields.invoice_number,
        verified:
          invoice.verification_state === 'verified'
            ? true
            : invoice.verification_state === 'rejected'
              ? false
              : null,
      })),
      external_facts: externalFacts,
      field_states: fieldStates,
    });
    return SrsInputSnapshotSchema.parse({
      input,
      provenance: {
        source_ref: input.document,
        materials_version: head.version,
        invoice_versions: invoices.map((invoice) => ({
          id: invoice.id,
          version: invoice.version,
        })),
        external_refs: externalRefs,
        field_catalog_version: 1,
        mapping_versions: [{ id: 'map-expense-v1', version: 1 }],
        normalization_version: 'expense-normalization-v1',
        input_hash: canonicalHash(input),
      },
    });
  };
  if (executor) return read(executor);
  return service.database.db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    return read(tx);
  });
}
export async function getApprovalTask(
  service: DocumentService,
  actor: ActorContext,
  ref: ResourceRef,
  executor: DatabaseExecutor = service.database.db,
) {
  const [task] = await rows<{
    id: string;
    version: number;
    assigned_to: string;
    node: 'manager' | 'finance';
    state: 'pending' | 'approved' | 'returned' | 'cancelled';
  }>(
    executor,
    sql`SELECT id,version,assigned_to,node,state FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND resource_type=${ref.type} AND resource_id=${ref.id} ORDER BY (state='pending') DESC,created_at DESC,id DESC LIMIT 1`,
  );
  return task
    ? {
        id: task.id,
        version: task.version,
        assigned_to: task.assigned_to,
        stage: task.node,
        status: task.state,
      }
    : null;
}
export async function listCurrentApprovalDocuments(
  service: DocumentService,
  actor: ActorContext,
) {
  const current = await service.identity.requireCurrentActor(actor);
  await service.identity.assertPermission(current, 'approval.decide');
  const result = await rows<{
    resource_type: 'travel' | 'expense_claim' | 'oa_request';
    resource_id: string;
    resource_version: number;
  }>(
    service.database.db,
    sql`SELECT resource_type,resource_id,resource_version FROM approval_tasks WHERE tenant_id=${current.tenant_id} AND assigned_to=${current.user_id} AND state='pending' ORDER BY created_at,id`,
  );
  return result.map((row) => ({
    type: row.resource_type,
    id: row.resource_id,
    version: row.resource_version,
  }));
}
