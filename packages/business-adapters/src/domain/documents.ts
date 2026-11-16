import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  BusinessObjectFieldsSchema,
  ResourceRefSchema,
} from '@caixiaozhi/contracts/common';
import { NonNegativeMoneySchema } from '@caixiaozhi/contracts/finance-common';
import {
  TravelCreateSchema,
  TravelDraftSchema,
  TravelSaveSchema,
  TravelLegSchema,
  TravelOperationSchema,
  TravelStateSchema,
  type TravelOperation,
} from '@caixiaozhi/contracts/travel';
import {
  OaCreateSchema,
  OaDraftSchema,
  OaSaveSchema,
  OaStateSchema,
} from '@caixiaozhi/contracts/oa';
import {
  ExpenseCreateSchema,
  ExpenseDraftSchema,
  ExpenseSaveSchema,
  ExpenseItemSchema,
  ExpenseStateSchema,
} from '@caixiaozhi/contracts/expenses';
import { AppError } from '@caixiaozhi/platform/errors';
import type {
  DatabaseConnection,
  DatabaseExecutor,
  Transaction,
} from '@caixiaozhi/platform/database';
import type { IdentityService } from '@caixiaozhi/identity';
import { calculateTravelBudget, businessDaysBetween } from './calculations.js';
import {
  rows,
  rawDocument,
  visibleList,
  idempotent,
  recordDocumentEvent,
  assertEditable,
  conflict,
  missing,
  validation,
  money,
  type BusinessKind,
  type DocumentHead,
} from './store.js';

export type ProposalMaterial = {
  id: string;
  version: number;
  sha256: string;
  content_type: string;
  text?: string | null;
};
const publicMetadata = {
  ...BusinessObjectFieldsSchema.shape,
  owner_id: z.string().min(1),
  applicant_id: z.string().min(1),
  department_id: z.string().min(1),
  submitted_at: z.iso.datetime().nullable(),
  approval_tasks: z.array(
    z.strictObject({
      id: z.string(),
      version: z.number().int().positive(),
      assigned_to: z.string(),
      node: z.enum(['manager', 'finance']),
      state: z.enum(['pending', 'approved', 'returned', 'cancelled']),
      resource_version: z.number().int().positive(),
    }),
  ),
  history: z.array(
    z.strictObject({
      id: z.string(),
      task_id: z.string(),
      actor_id: z.string(),
      decision: z.enum(['approve', 'return']),
      reason: z.string(),
      resource_before_version: z.number().int().positive(),
      resource_after_version: z.number().int().positive(),
      created_at: z.iso.datetime(),
    }),
  ),
};
export const BusinessDocumentSchemas = {
  travel: TravelDraftSchema.extend({
    ...publicMetadata,
    state: TravelStateSchema,
    resource_ref: ResourceRefSchema.extend({ type: z.literal('travel') }),
    total_budget: NonNegativeMoneySchema,
    approved_at: z.iso.datetime().nullable(),
  }),
  expense_claim: ExpenseDraftSchema.extend({
    ...publicMetadata,
    state: ExpenseStateSchema,
    resource_ref: ResourceRefSchema.extend({
      type: z.literal('expense_claim'),
    }),
    total_amount: NonNegativeMoneySchema,
    completed_at: z.iso.datetime().nullable(),
  }),
  oa_request: OaDraftSchema.extend({
    ...publicMetadata,
    state: OaStateSchema,
    resource_ref: ResourceRefSchema.extend({ type: z.literal('oa_request') }),
    budget_usage: z.strictObject({
      consumed: NonNegativeMoneySchema,
      reserved: NonNegativeMoneySchema,
      available: NonNegativeMoneySchema.nullable(),
    }),
    approved_at: z.iso.datetime().nullable(),
  }),
};
export type BusinessDocumentMap = {
  [K in BusinessKind]: z.infer<(typeof BusinessDocumentSchemas)[K]>;
};
export type BusinessDocument<K extends BusinessKind = BusinessKind> =
  BusinessDocumentMap[K];
export type BusinessOptions = {
  identity: IdentityService;
  businessDate?: () => Promise<string>;
  enqueueDomainJob?: typeof import('@caixiaozhi/jobs/queue').enqueueInTransaction;
  authorizeMaterial?: (
    actor: ActorContext,
    ref: { id: string; version: number; purpose?: string },
    parent: ResourceRef,
    tx?: DatabaseExecutor,
  ) => Promise<void>;
  readProposalMaterial?: (
    actor: ActorContext,
    ref: { id: string; version: number; purpose?: string },
  ) => Promise<ProposalMaterial>;
  bindInvoiceFile?: (
    actor: ActorContext,
    fileId: string,
    parent: ResourceRef,
    tx: DatabaseExecutor,
  ) => Promise<void>;
  proposeTravel?: (input: {
    actor: ActorContext;
    document: BusinessDocument<'travel'>;
    prompt: string;
    material_refs: ProposalMaterial[];
  }) => Promise<{ operations: TravelOperation[]; clarifications: string[] }>;
  proposeExpense?: (input: {
    actor: ActorContext;
    document: BusinessDocument<'expense_claim'>;
    prompt: string;
    material_refs: ProposalMaterial[];
    invoice_snapshots: unknown[];
  }) => Promise<unknown>;
};
export class DocumentService {
  readonly identity: IdentityService;
  constructor(
    readonly database: DatabaseConnection,
    readonly options: BusinessOptions,
  ) {
    this.identity = options.identity;
  }
  async businessDate() {
    return this.options.businessDate
      ? this.options.businessDate()
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
          new Date(),
        );
  }
  async department(actor: ActorContext) {
    return (await this.identity.getMe(actor)).department_id;
  }
  async metadata(
    actor: ActorContext,
    ref: { type: string; id: string; version: number },
  ) {
    if (!['travel', 'expense_claim', 'oa_request'].includes(ref.type))
      return null;
    try {
      const head = await rawDocument(
        this.database.db,
        actor,
        ref.type as BusinessKind,
        ref.id,
      );
      const [task] = await rows<{ assigned_to: string; node: string }>(
        this.database.db,
        sql`SELECT assigned_to,node FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND resource_type=${ref.type} AND resource_id=${ref.id} AND state='pending'`,
      );
      return {
        tenant_id: head.tenant_id,
        owner_id: head.owner_id,
        department_id: head.department_id,
        version: head.version,
        ...(task
          ? {
              assigned_to: task.assigned_to,
              status: 'pending',
              stage: task.node,
            }
          : { status: head.state }),
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }
  async get<K extends BusinessKind>(
    actor: ActorContext,
    kind: K,
    id: string,
    executor: DatabaseExecutor = this.database.db,
  ): Promise<BusinessDocument<K>> {
    const current = await this.identity.requireCurrentActor(actor);
    const head = await rawDocument(executor, current, kind, id);
    const prefix =
      kind === 'expense_claim'
        ? 'expense'
        : kind === 'oa_request'
          ? 'oa'
          : 'travel';
    await this.identity.assertResourceAccess(current, `${prefix}.read`, {
      type: kind,
      id,
      version: head.version,
    });
    return this.project(executor, kind, head);
  }
  async project<K extends BusinessKind>(
    db: DatabaseExecutor,
    kind: K,
    head: DocumentHead,
  ): Promise<BusinessDocument<K>> {
    const common = {
      id: head.id,
      tenant_id: head.tenant_id,
      owner_id: head.owner_id,
      applicant_id: head.owner_id,
      department_id: head.department_id,
      version: head.version,
      state: head.state,
      title: head.title,
      purpose: head.purpose,
      created_at: new Date(head.created_at).toISOString(),
      updated_at: new Date(head.updated_at).toISOString(),
      submitted_at: head.submitted_at
        ? new Date(head.submitted_at).toISOString()
        : null,
      resource_ref: {
        type: kind,
        id: head.id,
        version: head.version,
      } as ResourceRef,
    };
    let details: Record<string, unknown>;
    if (kind === 'travel') {
      const legs = await rows<{ data: unknown }>(
        db,
        sql`SELECT data FROM travel_legs WHERE tenant_id=${head.tenant_id} AND travel_id=${head.id} ORDER BY ordinal`,
      );
      details = {
        ...TravelDraftSchema.parse({
          title: head.title,
          purpose: head.purpose,
          cost_center_id: head.cost_center_id,
          project_id: head.project_id ?? null,
          material_refs: head.material_refs ?? [],
          legs: legs.map((leg) => TravelLegSchema.parse(leg.data)),
        }),
        total_budget: money(head.total_minor),
        approved_at: head.approved_at
          ? new Date(head.approved_at).toISOString()
          : null,
      };
    } else if (kind === 'expense_claim') {
      const items = await rows<{ data: unknown }>(
        db,
        sql`SELECT data FROM expense_items WHERE tenant_id=${head.tenant_id} AND claim_id=${head.id} ORDER BY id`,
      );
      details = {
        ...ExpenseDraftSchema.parse({
          title: head.title,
          purpose: head.purpose,
          cost_center_id: head.cost_center_id,
          material_refs: head.material_refs ?? [],
          items: items.map((item) => ExpenseItemSchema.parse(item.data)),
        }),
        total_amount: money(head.total_minor),
        completed_at: head.completed_at
          ? new Date(head.completed_at).toISOString()
          : null,
      };
    } else {
      details = {
        ...OaDraftSchema.parse({
          title: head.title,
          purpose: head.purpose,
          entertainment_date: head.entertainment_date
            ? String(head.entertainment_date).slice(0, 10)
            : null,
          entertained_party: head.entertained_party,
          budget: head.budget_minor == null ? null : money(head.budget_minor),
        }),
        budget_usage: {
          consumed: money(head.consumed_minor as string),
          reserved: money(head.reserved_minor as string),
          available:
            head.budget_minor == null
              ? null
              : money(
                  BigInt(head.budget_minor) -
                    BigInt(head.consumed_minor as string) -
                    BigInt(head.reserved_minor as string),
                ),
        },
        approved_at: head.approved_at
          ? new Date(head.approved_at).toISOString()
          : null,
      };
    }
    const history = await rows<Record<string, unknown>>(
      db,
      sql`SELECT d.id,d.task_id,d.actor_id,d.decision,d.reason,d.resource_before_version,d.resource_after_version,d.created_at FROM approval_decisions d JOIN approval_tasks t ON t.tenant_id=d.tenant_id AND t.id=d.task_id WHERE t.tenant_id=${head.tenant_id} AND t.resource_type=${kind} AND t.resource_id=${head.id} ORDER BY d.created_at,d.id`,
    );
    const tasks = await rows<Record<string, unknown>>(
      db,
      sql`SELECT id,version,assigned_to,node,state,resource_version FROM approval_tasks WHERE tenant_id=${head.tenant_id} AND resource_type=${kind} AND resource_id=${head.id} ORDER BY created_at,id`,
    );
    const projected = {
      ...common,
      ...details,
      approval_tasks: tasks,
      history: history.map((entry) => ({
        ...entry,
        created_at: new Date(entry.created_at as string).toISOString(),
      })),
    };
    return BusinessDocumentSchemas[kind].parse(
      projected,
    ) as BusinessDocument<K>;
  }
  async list<K extends BusinessKind>(
    actor: ActorContext,
    kind: K,
    input: { cursor?: string | null; limit?: number; state?: string } = {},
  ): Promise<{ items: BusinessDocument<K>[]; next_cursor: string | null }> {
    const current = await this.identity.requireCurrentActor(actor);
    const page = await visibleList(
      this.database.db,
      this.identity,
      current,
      kind,
      input,
    );
    return {
      items: await Promise.all(
        page.items.map((head) => this.project(this.database.db, kind, head)),
      ),
      next_cursor: page.next_cursor,
    };
  }
  async create<K extends BusinessKind>(
    actor: ActorContext,
    kind: K,
    input: unknown,
    key: string,
  ): Promise<BusinessDocument<K>> {
    const current = await this.identity.requireCurrentActor(actor);
    const prefix =
      kind === 'expense_claim'
        ? 'expense'
        : kind === 'oa_request'
          ? 'oa'
          : 'travel';
    await this.identity.assertPermission(current, `${prefix}.write.own`);
    const parsed = (
      kind === 'travel'
        ? TravelCreateSchema
        : kind === 'expense_claim'
          ? ExpenseCreateSchema
          : OaCreateSchema
    ).parse(input);
    const department = await this.department(current);
    return idempotent(
      this.database,
      current,
      `${prefix}.create`,
      key,
      parsed,
      async (tx) => {
        const id = randomUUID();
        const table =
          kind === 'travel'
            ? 'travel_requests'
            : kind === 'expense_claim'
              ? 'expense_claims'
              : 'entertainment_requests';
        await tx.execute(
          sql`INSERT INTO ${sql.raw(table)}(tenant_id,id,owner_id,department_id,state,title) VALUES(${current.tenant_id},${id},${current.user_id},${department},'draft',${parsed.title})`,
        );
        await recordDocumentEvent(
          tx,
          current,
          kind,
          id,
          1,
          `${prefix}.created`,
        );
        return this.project(tx, kind, await rawDocument(tx, current, kind, id));
      },
    );
  }
  async saveTravel(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
    executor?: Transaction,
  ): Promise<BusinessDocument<'travel'>> {
    const parsed = TravelSaveSchema.parse(input);
    const current = await this.identity.requireCurrentActor(actor);
    await this.identity.assertResourceAccess(current, 'travel.write.own', {
      type: 'travel',
      id,
      version: parsed.expected_version,
    });
    const write = async (tx: Transaction) => {
      const head = await rawDocument(tx, current, 'travel', id, true);
      assertEditable(head, current, parsed.expected_version);
      for (const ref of parsed.material_refs) {
        if (!this.options.authorizeMaterial)
          throw validation('材料授权服务未配置。');
        await this.options.authorizeMaterial(
          current,
          ref,
          { type: 'travel', id, version: head.version + 1 },
          tx,
        );
      }
      const ids = new Set<string>();
      for (const [index, leg] of parsed.legs.entries()) {
        if (ids.has(leg.leg_id)) throw validation('行程标识重复。');
        ids.add(leg.leg_id);
        if (leg.ordinal !== index + 1)
          throw validation('行程顺序必须从1连续排列。');
        if (
          leg.departure_date &&
          leg.end_date &&
          leg.end_date < leg.departure_date
        )
          throw validation('行程结束日期不能早于出发日期。');
        if (
          leg.from_city_id &&
          leg.to_city_id &&
          leg.from_city_id === leg.to_city_id
        )
          throw validation('差旅出发和到达城市必须不同。');
        if (
          index > 0 &&
          parsed.legs[index - 1]!.end_date &&
          leg.departure_date &&
          leg.departure_date < parsed.legs[index - 1]!.end_date!
        )
          throw validation('相邻行程日期不能重叠。');
        if (
          leg.lodging_required &&
          leg.check_in &&
          leg.check_out &&
          businessDaysBetween(leg.check_in, leg.check_out) <= 0
        )
          throw validation('退房日期必须晚于入住日期。');
        if (
          leg.lodging_required &&
          leg.check_in &&
          leg.departure_date &&
          leg.check_in < leg.departure_date
        )
          throw validation('入住日期不能早于行程。');
        if (
          leg.lodging_required &&
          leg.check_out &&
          leg.end_date &&
          leg.check_out > leg.end_date
        )
          throw validation('退房日期不能超出行程结束日期。');
        if (
          BigInt(leg.other_budget.amount_minor) > 0n &&
          !leg.other_reason.trim()
        )
          throw validation('其他预算需要填写用途。');
      }
      const first = parsed.legs[0]?.departure_date,
        last = parsed.legs.at(-1)?.end_date;
      if (first && last && businessDaysBetween(first, last) > 366)
        throw validation('差旅行程不能超过366天。');
      if (parsed.cost_center_id)
        await this.identity.validateCostCenter(
          current,
          parsed.cost_center_id,
          await this.businessDate(),
        );
      if (parsed.project_id)
        await this.identity.validateProject(
          current,
          parsed.project_id,
          await this.businessDate(),
        );
      const oldLegs = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM travel_legs WHERE tenant_id=${current.tenant_id} AND travel_id=${id}`,
      );
      const known = new Set(oldLegs.map((leg) => leg.id));
      const legs = parsed.legs
        .map((leg) => {
          if (known.has(leg.leg_id)) return leg;
          if (!leg.leg_id.startsWith('new:'))
            throw validation('新增行程请使用新增行程操作。');
          return { ...leg, leg_id: randomUUID() };
        })
        .map((leg) =>
          leg.lodging_required
            ? leg
            : {
                ...leg,
                check_in: null,
                check_out: null,
                room_count: null,
                nightly_room_budget: null,
              },
        );
      const total = calculateTravelBudget(legs);
      await tx.execute(
        sql`UPDATE travel_requests SET title=${parsed.title},purpose=${parsed.purpose},cost_center_id=${parsed.cost_center_id},project_id=${parsed.project_id},material_refs=${JSON.stringify(parsed.material_refs)}::jsonb,total_minor=${total.amount_minor},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
      );
      await tx.execute(
        sql`DELETE FROM travel_legs WHERE tenant_id=${current.tenant_id} AND travel_id=${id}`,
      );
      for (const leg of legs)
        await tx.execute(
          sql`INSERT INTO travel_legs(tenant_id,travel_id,id,ordinal,data) VALUES(${current.tenant_id},${id},${leg.leg_id},${leg.ordinal},${JSON.stringify(leg)}::jsonb)`,
        );
      await tx.execute(
        sql`UPDATE travel_proposals SET state='stale',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND travel_id=${id} AND state='proposed'`,
      );
      await recordDocumentEvent(
        tx,
        current,
        'travel',
        id,
        head.version + 1,
        'travel.updated',
      );
      return this.project(
        tx,
        'travel',
        await rawDocument(tx, current, 'travel', id),
      );
    };
    return executor
      ? write(executor)
      : idempotent(
          this.database,
          current,
          'travel.save',
          key,
          { id, ...parsed },
          write,
        );
  }
  async saveOa(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ): Promise<BusinessDocument<'oa_request'>> {
    const parsed = OaSaveSchema.parse(input),
      current = await this.identity.requireCurrentActor(actor);
    await this.identity.assertResourceAccess(current, 'oa.write.own', {
      type: 'oa_request',
      id,
      version: parsed.expected_version,
    });
    return idempotent(
      this.database,
      current,
      'oa.save',
      key,
      { id, ...parsed },
      async (tx) => {
        const head = await rawDocument(tx, current, 'oa_request', id, true);
        assertEditable(head, current, parsed.expected_version);
        await tx.execute(
          sql`UPDATE entertainment_requests SET title=${parsed.title},purpose=${parsed.purpose},entertainment_date=${parsed.entertainment_date},entertained_party=${parsed.entertained_party},budget_minor=${parsed.budget?.amount_minor ?? null},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
        );
        await recordDocumentEvent(
          tx,
          current,
          'oa_request',
          id,
          head.version + 1,
          'oa.updated',
        );
        return this.project(
          tx,
          'oa_request',
          await rawDocument(tx, current, 'oa_request', id),
        );
      },
    );
  }
  async saveExpense(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
    executor?: Transaction,
  ): Promise<BusinessDocument<'expense_claim'>> {
    const parsed = ExpenseSaveSchema.parse(input),
      current = await this.identity.requireCurrentActor(actor);
    await this.identity.assertResourceAccess(current, 'expense.write.own', {
      type: 'expense_claim',
      id,
      version: parsed.expected_version,
    });
    if (
      new Set(parsed.items.map((item) => item.invoice_id)).size !==
      parsed.items.length
    )
      throw validation('同一票据只能生成一条费用。');
    const total = parsed.items.reduce(
      (sum, item) => sum + BigInt(item.claim_amount.amount_minor),
      0n,
    );
    if (total > 100_000_000n) throw validation('报销金额超过上限。');
    const write = async (tx: Transaction) => {
      const head = await rawDocument(tx, current, 'expense_claim', id, true);
      assertEditable(head, current, parsed.expected_version);
      for (const ref of parsed.material_refs) {
        if (!this.options.authorizeMaterial)
          throw validation('材料授权服务未配置。');
        await this.options.authorizeMaterial(
          current,
          ref,
          { type: 'expense_claim', id, version: head.version + 1 },
          tx,
        );
      }
      if (parsed.cost_center_id)
        await this.identity.validateCostCenter(
          current,
          parsed.cost_center_id,
          await this.businessDate(),
        );
      for (const item of [...parsed.items].sort((a, b) =>
        a.invoice_id.localeCompare(b.invoice_id),
      )) {
        const [invoice] = await rows<{
          owner_id: string;
          version: number;
          confirmation_state: string;
          gross_minor: string;
          file_id: string;
        }>(
          tx,
          sql`SELECT owner_id,version,confirmation_state,gross_minor::text,file_id FROM invoices WHERE tenant_id=${current.tenant_id} AND id=${item.invoice_id} FOR UPDATE`,
        );
        if (!invoice || invoice.owner_id !== current.user_id) throw missing();
        if (invoice.version !== item.invoice_version) throw conflict();
        if (invoice.confirmation_state !== 'confirmed')
          throw validation('请先确认票面字段与费用类型。');
        if (
          BigInt(item.claim_amount.amount_minor) > BigInt(invoice.gross_minor)
        )
          throw validation('申报金额不能超过票面金额。');
        if (
          BigInt(item.claim_amount.amount_minor) <
            BigInt(invoice.gross_minor) &&
          !item.reduction_reason?.trim()
        )
          throw validation('少报票面金额需要说明原因。');
        const [reservation] = await rows<{ claim_id: string }>(
          tx,
          sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND invoice_id=${item.invoice_id}`,
        );
        if (reservation && reservation.claim_id !== id)
          throw validation('该票据可能已使用，请联系财务核实。', [
            { code: 'DUPLICATE_INVOICE', path: 'items' },
          ]);
        await tx.execute(
          sql`INSERT INTO invoice_reservations(tenant_id,invoice_id,claim_id) VALUES(${current.tenant_id},${item.invoice_id},${id}) ON CONFLICT DO NOTHING`,
        );
        const [held] = await rows<{ claim_id: string }>(
          tx,
          sql`SELECT claim_id FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND invoice_id=${item.invoice_id}`,
        );
        if (held?.claim_id !== id)
          throw validation('该票据可能已使用，请联系财务核实。');
        if (!this.options.bindInvoiceFile)
          throw validation('票据文件关联服务未配置。');
        await this.options.bindInvoiceFile(
          current,
          invoice.file_id,
          { type: 'expense_claim', id, version: head.version + 1 },
          tx,
        );
      }
      const invoiceIds = parsed.items.map((item) => item.invoice_id);
      await tx.execute(
        sql`DELETE FROM expense_items WHERE tenant_id=${current.tenant_id} AND claim_id=${id}`,
      );
      await tx.execute(
        sql`DELETE FROM invoice_reservations WHERE tenant_id=${current.tenant_id} AND claim_id=${id} AND NOT (invoice_id=ANY(${sql.param(invoiceIds)}::text[]))`,
      );
      for (const item of parsed.items)
        await tx.execute(
          sql`INSERT INTO expense_items(tenant_id,claim_id,id,invoice_id,data,amount_minor,expense_type) VALUES(${current.tenant_id},${id},${item.item_id},${item.invoice_id},${JSON.stringify(item)}::jsonb,${item.claim_amount.amount_minor},${item.expense_type})`,
        );
      await tx.execute(
        sql`UPDATE expense_claims SET title=${parsed.title},purpose=${parsed.purpose},cost_center_id=${parsed.cost_center_id},material_refs=${JSON.stringify(parsed.material_refs)}::jsonb,total_minor=${total.toString()},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND id=${id}`,
      );
      await tx.execute(
        sql`UPDATE expense_proposals SET state='stale',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${current.tenant_id} AND claim_id=${id} AND state='proposed'`,
      );
      await recordDocumentEvent(
        tx,
        current,
        'expense_claim',
        id,
        head.version + 1,
        'expense.updated',
      );
      return this.project(
        tx,
        'expense_claim',
        await rawDocument(tx, current, 'expense_claim', id),
      );
    };
    return executor
      ? write(executor)
      : idempotent(
          this.database,
          current,
          'expense.save',
          key,
          { id, ...parsed },
          write,
        );
  }
}
