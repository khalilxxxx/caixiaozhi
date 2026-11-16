import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ActorContext,
  ResourceRef,
  ActionReceipt,
} from '@caixiaozhi/contracts/common';
import { ResourceRefSchema } from '@caixiaozhi/contracts/common';
import { PreauditVersionLockSchema } from '@caixiaozhi/contracts/preaudit';
import type { PreauditEligibilityPort } from '@caixiaozhi/contracts/preaudit-eligibility';
import { TaskRefSchema, type ActionName } from '@caixiaozhi/contracts/actions';
import type { DatabaseExecutor } from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type {
  ActionHandler,
  ActionContext,
  ConfirmedAction,
} from '../ports.js';
import { DocumentService } from './documents.js';
import { validateSubmission } from './validation.js';
import { reserveOaBudget, settleOaBudget } from './oa-budget.js';
import {
  rows,
  rawDocument,
  snapshot,
  recordDocumentEvent,
  documentTables,
  money,
  missing,
  conflict,
  validation,
  type BusinessKind,
} from './store.js';

const DecisionArgsSchema = z.strictObject({
  task_ref: TaskRefSchema,
  reason: z.string().max(1000).default(''),
  review_ack: z.record(z.string(), z.unknown()).nullable().default(null),
  preaudit_result_id: z.string().optional(),
});
const SubmitArgsSchema = z.strictObject({});
const BatchArgsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        resource_id: z.string(),
        task_ref: TaskRefSchema,
        preaudit_result_id: z.string(),
      }),
    )
    .min(1)
    .max(50),
});
export type EligibilityCheck =
  PreauditEligibilityPort<DatabaseExecutor>['check'];
export type ApprovalOptions = {
  eligibility?: EligibilityCheck;
  validateManualReview?: (
    actor: ActorContext,
    ref: ResourceRef,
    ack: Record<string, unknown> | null,
    reason: string,
    tx?: DatabaseExecutor,
  ) => Promise<void>;
};
type Task = {
  id: string;
  version: number;
  assigned_to: string;
  state: string;
  node: 'manager' | 'finance';
  resource_version: number;
  submission_id: string;
};
export class ApprovalService {
  constructor(
    readonly documents: DocumentService,
    readonly options: ApprovalOptions = {},
  ) {}
  async list(
    actor: ActorContext,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const current = await this.documents.identity.requireCurrentActor(actor);
    let scopeFilter;
    if (current.invocation_origin === 'subscription') {
      const [travel, expense, oa] = await Promise.all(
        ['travel.read', 'expense.read', 'oa.read'].map((operation) =>
          this.documents.identity.getResourceScope(current, operation),
        ),
      );
      scopeFilter = sql`((resource_type='travel' AND department_id=ANY(${sql.param(travel!.department_ids)}::text[])) OR (resource_type='expense_claim' AND department_id=ANY(${sql.param(expense!.department_ids)}::text[])) OR (resource_type='oa_request' AND department_id=ANY(${sql.param(oa!.department_ids)}::text[])))`;
    } else {
      await this.documents.identity.assertPermission(
        current,
        'approval.decide',
      );
      const scope = await this.documents.identity.getResourceScope(
        current,
        'approval.decide',
      );
      scopeFilter = sql`department_id=ANY(${sql.param(scope.assigned_task_department_ids)}::text[])`;
    }
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100);
    const tasks = await rows<{
      resource_type: BusinessKind;
      resource_id: string;
      id: string;
      version: number;
      node: string;
    }>(
      this.documents.database.db,
      sql`SELECT * FROM approval_tasks WHERE tenant_id=${current.tenant_id} AND assigned_to=${current.user_id} AND ${scopeFilter} AND state='pending' ${input.cursor ? sql`AND id>${input.cursor}` : sql``} ORDER BY id LIMIT ${limit + 1}`,
    );
    const items = await Promise.all(
      tasks.slice(0, limit).map(async (task) => ({
        task_ref: { id: task.id, version: task.version },
        node: task.node,
        document: await this.documents.get(
          current,
          task.resource_type,
          task.resource_id,
        ),
      })),
    );
    const totals = items.reduce(
      (sum, item) =>
        sum +
        BigInt(
          (
            (
              item.document as {
                total_amount?: { amount_minor: string };
                total_budget?: { amount_minor: string };
                budget?: { amount_minor: string } | null;
              }
            ).total_amount ??
            (item.document as { total_budget?: { amount_minor: string } })
              .total_budget ??
            (item.document as { budget?: { amount_minor: string } | null })
              .budget
          )?.amount_minor ?? '0',
        ),
      0n,
    );
    const [count] = await rows<{ count: number }>(
      this.documents.database.db,
      sql`SELECT count(*)::int AS count FROM approval_tasks WHERE tenant_id=${current.tenant_id} AND assigned_to=${current.user_id} AND ${scopeFilter} AND state='pending'`,
    );
    return {
      items,
      next_cursor: tasks.length > limit ? tasks[limit - 1]!.id : null,
      count: count?.count ?? 0,
      page_total: money(totals),
    };
  }
  async detail(actor: ActorContext, id: string) {
    const [task] = await rows<{
      resource_type: BusinessKind;
      resource_id: string;
      assigned_to: string;
    }>(
      this.documents.database.db,
      sql`SELECT resource_type,resource_id,assigned_to FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND id=${id}`,
    );
    if (!task || task.assigned_to !== actor.user_id) throw missing();
    return {
      task_id: id,
      document: await this.documents.get(
        actor,
        task.resource_type,
        task.resource_id,
      ),
    };
  }
  async history(actor: ActorContext, id: string, _query: unknown = {}) {
    return this.detail(actor, id);
  }
  async currentTask(
    db: DatabaseExecutor,
    actor: ActorContext,
    ref: ResourceRef,
    lock = false,
  ) {
    const [task] = await rows<Task>(
      db,
      sql`SELECT id,version,assigned_to,state,node,resource_version,submission_id FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND resource_type=${ref.type} AND resource_id=${ref.id} AND state='pending' ${lock ? sql`FOR UPDATE` : sql``}`,
    );
    if (!task)
      throw new AppError('INVALID_STATE', '当前单据没有待处理的审批任务。');
    return task;
  }
  async createTask(
    db: DatabaseExecutor,
    actor: ActorContext,
    ref: ResourceRef,
    ownerId: string,
    departmentId: string,
    node: 'manager' | 'finance',
    submissionId: string,
  ) {
    let assignedTo: string;
    if (node === 'manager')
      assignedTo = (
        await this.documents.identity.resolveManager(actor, departmentId)
      ).id;
    else {
      const candidates = await rows<{ id: string }>(
        db,
        sql`SELECT i.id FROM identities i JOIN grants g ON g.tenant_id=i.tenant_id AND g.subject_id=i.id WHERE i.tenant_id=${actor.tenant_id} AND i.state='active' AND g.capability='approval.decide' AND g.scope_type='assigned_task' AND g.scope_ids @> ${JSON.stringify([departmentId])}::jsonb AND EXISTS(SELECT 1 FROM role_assignments r WHERE r.tenant_id=i.tenant_id AND r.user_id=i.id AND r.role='finance' AND r.valid_from<=now() AND (r.valid_to IS NULL OR r.valid_to>now())) GROUP BY i.id ORDER BY i.id`,
      );
      if (candidates.length !== 1)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '未能唯一确定当前部门的财务审核人，请检查授权配置。',
        );
      assignedTo = candidates[0]!.id;
    }
    await db.execute(
      sql`INSERT INTO approval_tasks(tenant_id,id,resource_type,resource_id,resource_version,owner_id,department_id,assigned_to,node,state,submission_id) VALUES(${actor.tenant_id},${randomUUID()},${ref.type},${ref.id},${ref.version},${ownerId},${departmentId},${assignedTo},${node},'pending',${submissionId})`,
    );
  }
  async receipt(
    ctx: ActionContext,
    action: ConfirmedAction,
    db: DatabaseExecutor,
    ref: ResourceRef,
  ): Promise<ActionReceipt> {
    const receipt: ActionReceipt = {
      id: randomUUID(),
      action_id: ctx.action_id,
      idempotency_key: ctx.idempotency_key,
      outcome: 'succeeded',
      resource: ref,
      external_receipt_id: ctx.external_request_id,
      occurred_at: new Date().toISOString(),
      data_mode: 'demo',
      error_code: null,
    };
    await db.execute(
      sql`INSERT INTO business_receipts(tenant_id,id,action_id,item_id,receipt) VALUES(${ctx.actor.tenant_id},${receipt.id},${ctx.action_id},${ctx.item_id},${JSON.stringify(receipt)}::jsonb)`,
    );
    return receipt;
  }
  batchHandler(): ActionHandler {
    const FrozenGuard = z.strictObject({
      result_hash: z.string(),
      lock_hash: z.string(),
      locked_versions: PreauditVersionLockSchema,
    });
    const ItemArgs = z.strictObject({
      task_ref: TaskRefSchema,
      preaudit_result_id: z.string(),
      expected_guards: z
        .strictObject({ result_hash: z.string(), lock_hash: z.string() })
        .optional(),
      frozen_batch_guards: z.record(z.string(), FrozenGuard).optional(),
    });
    return {
      mode: 'local',
      validate: async (actor, args, refs, tx) => {
        if (!this.options.eligibility)
          throw new AppError(
            'DEPENDENCY_UNAVAILABLE',
            '低风险批量资格服务尚未就绪。',
          );
        const db = tx ?? this.documents.database.db;
        const single = ItemArgs.safeParse(args);
        const input = single.success
          ? {
              items: [
                {
                  resource_id: refs[0]?.id,
                  task_ref: single.data.task_ref,
                  preaudit_result_id: single.data.preaudit_result_id,
                },
              ],
            }
          : BatchArgsSchema.parse(args);
        if (
          input.items.length !== refs.length ||
          refs.some((ref) => ref.type !== 'expense_claim')
        )
          throw validation('批量批准仅支持精确选择的报销单据。');
        const items = [];
        const nodes = new Set<string>();
        let total = 0n;
        const frozenBatch =
          single.success && single.data.frozen_batch_guards
            ? single.data.frozen_batch_guards
            : {};
        for (const ref of refs) {
          const selected = input.items.find(
            (item) => item.resource_id === ref.id,
          );
          if (!selected) throw validation('确认范围与所选单据不一致。');
          const head = await rawDocument(
            db,
            actor,
            'expense_claim',
            ref.id,
            Boolean(tx),
          );
          if (head.version !== ref.version) throw conflict();
          await this.documents.identity.assertResourceAccess(
            actor,
            'approval.decide',
            ref,
          );
          const task = await this.currentTask(db, actor, ref, Boolean(tx));
          if (
            task.id !== selected.task_ref.id ||
            task.version !== selected.task_ref.version ||
            task.assigned_to !== actor.user_id
          )
            throw conflict();
          nodes.add(task.node);
          total += BigInt(head.total_minor ?? '0');
          const report = await validateSubmission(
            this.documents,
            actor,
            ref,
            db,
          );
          if (!report.valid)
            throw validation('单据存在业务硬阻断。', report.errors);
          const eligibility = await this.options.eligibility(
            actor,
            {
              resource_ref: ref,
              task_ref: selected.task_ref,
              preaudit_result_id: selected.preaudit_result_id,
              expected_purpose:
                task.node === 'manager' ? 'manager_review' : 'finance_review',
              ...(single.success && single.data.expected_guards
                ? { expected_guards: single.data.expected_guards }
                : {}),
            },
            tx,
          );
          if (!eligibility.eligible)
            throw new AppError(
              'REVALIDATION_REQUIRED',
              '低风险结论已失效或不属于当前审核人，请重新预审。',
              { details: { reasons: eligibility.rejection_reasons } },
            );
          const proof = {
            result_hash: eligibility.result_hash,
            lock_hash: eligibility.lock_hash,
            locked_versions: eligibility.locked_versions,
          };
          if (!single.success) frozenBatch[ref.id] = proof;
          const itemArgs = {
            task_ref: selected.task_ref,
            preaudit_result_id: selected.preaudit_result_id,
            expected_guards: {
              result_hash: proof.result_hash,
              lock_hash: proof.lock_hash,
            },
            frozen_batch_guards: frozenBatch,
          };
          items.push({
            resource_ref: ref,
            task_ref: selected.task_ref,
            args: itemArgs,
            guards: proof,
          });
        }
        if (nodes.size !== 1)
          throw validation('同一批次不能混合主管与财务节点。');
        return {
          summary: {
            action: 'approval.batch_approve',
            count: refs.length,
            total: money(total),
            resource_refs: refs,
            node: [...nodes][0],
          },
          args: single.success ? single.data : args,
          extra_guards: { eligibility_items: frozenBatch },
          items,
        };
      },
      execute: async (ctx, tx, action) => {
        const parsed = ItemArgs.parse(action.item.args ?? action.args);
        const decision = {
          task_ref: parsed.task_ref,
          reason: '已查看当前低风险预审并明确确认本项批准。',
          review_ack: null,
          preaudit_result_id: parsed.preaudit_result_id,
        };
        return this.handler('approval.approve').execute(ctx, tx, {
          ...action,
          args: decision,
          item: { ...action.item, args: decision },
        });
      },
      queryOutcome: async (ctx, action) =>
        this.handler('approval.approve').queryOutcome(ctx, action),
    };
  }

  handler(operation: ActionName): ActionHandler {
    const isDecision =
      operation === 'approval.approve' || operation === 'approval.return';
    return {
      mode: 'local',
      validate: async (actor, args, refs, tx) => {
        if (
          refs.length !== 1 ||
          !['travel', 'expense_claim', 'oa_request'].includes(refs[0]!.type)
        )
          throw validation('请选择一份当前业务单据。');
        const ref = refs[0]!,
          kind = ref.type as BusinessKind,
          db = tx ?? this.documents.database.db;
        const head = await rawDocument(db, actor, kind, ref.id, Boolean(tx));
        if (head.version !== ref.version) throw conflict();
        const prefix =
          kind === 'expense_claim'
            ? 'expense'
            : kind === 'oa_request'
              ? 'oa'
              : 'travel';
        if (isDecision) {
          const parsed = DecisionArgsSchema.parse(args),
            task = await this.currentTask(db, actor, ref, Boolean(tx));
          await this.documents.identity.assertResourceAccess(
            actor,
            'approval.decide',
            ref,
          );
          if (task.assigned_to !== actor.user_id)
            throw new AppError('FORBIDDEN', '当前审批任务未指派给你。');
          if (
            task.id !== parsed.task_ref.id ||
            task.version !== parsed.task_ref.version ||
            task.resource_version !== head.version
          )
            throw conflict();
          if (operation === 'approval.return' && !parsed.reason.trim())
            throw validation('退回需要填写理由。');
          if (operation === 'approval.approve') {
            const report = await validateSubmission(
              this.documents,
              actor,
              ref,
              db,
            );
            if (!report.valid)
              throw validation(
                '单据存在业务硬阻断，请先退回补正。',
                report.errors,
              );
            await this.options.validateManualReview?.(
              actor,
              ref,
              parsed.review_ack,
              parsed.reason,
              tx,
            );
          }
          return {
            args: parsed,
            summary: {
              action: operation,
              resource_ref: ref,
              title: head.title,
              total: money(head.total_minor ?? head.budget_minor),
              task_ref: parsed.task_ref,
              reason: parsed.reason,
              review_ack: parsed.review_ack,
            },
            items: [
              { resource_ref: ref, task_ref: parsed.task_ref, args: parsed },
            ],
          };
        }
        SubmitArgsSchema.parse(args);
        await this.documents.identity.assertResourceAccess(
          actor,
          `${prefix}.write.own`,
          ref,
        );
        if (head.owner_id !== actor.user_id) throw missing();
        if (operation.endsWith('.withdraw')) {
          if (!['pending_manager', 'pending_finance'].includes(head.state))
            throw new AppError('INVALID_STATE', '当前状态不能撤回。');
        } else {
          if (
            operation.endsWith('.submit')
              ? head.state !== 'draft'
              : !['returned', 'withdrawn'].includes(head.state)
          )
            throw new AppError('INVALID_STATE', '当前状态不能提交。');
          const report = await validateSubmission(
            this.documents,
            actor,
            ref,
            db,
          );
          if (!report.valid)
            throw validation('请补齐提交字段。', report.errors);
          await this.documents.identity.resolveManager(
            actor,
            head.department_id,
          );
        }
        return {
          summary: {
            action: operation,
            resource_ref: ref,
            title: head.title,
            total: money(head.total_minor ?? head.budget_minor),
          },
          args: {},
          items: [{ resource_ref: ref, args: {} }],
        };
      },
      execute: async (ctx, tx, action) => {
        if (!tx) throw new Error('本地业务动作需要事务。');
        const ref = action.item.resource_ref!;
        const kind = ref.type as BusinessKind;
        const head = await rawDocument(tx, ctx.actor, kind, ref.id, true);
        if (head.version !== ref.version) throw conflict();
        let state: string;
        const version = head.version + 1;
        if (isDecision) {
          const parsed = DecisionArgsSchema.parse(
              action.item.args ?? action.args,
            ),
            task = await this.currentTask(tx, ctx.actor, ref, true);
          if (
            task.id !== parsed.task_ref.id ||
            task.version !== parsed.task_ref.version ||
            task.assigned_to !== ctx.actor.user_id
          )
            throw conflict();
          state =
            operation === 'approval.return'
              ? 'returned'
              : kind === 'expense_claim'
                ? task.node === 'manager'
                  ? 'pending_finance'
                  : 'completed'
                : 'approved';
          await tx.execute(
            sql`UPDATE approval_tasks SET state=${operation === 'approval.return' ? 'returned' : 'approved'},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${task.id}`,
          );
          await tx.execute(
            sql`INSERT INTO approval_decisions(tenant_id,id,task_id,actor_id,action_id,item_id,decision,reason,review_ack,resource_before_version,resource_after_version) VALUES(${ctx.actor.tenant_id},${randomUUID()},${task.id},${ctx.actor.user_id},${ctx.action_id},${ctx.item_id},${operation === 'approval.return' ? 'return' : 'approve'},${parsed.reason},${JSON.stringify(parsed.review_ack)}::jsonb,${head.version},${version})`,
          );
          await tx.execute(
            sql`UPDATE ${sql.raw(documentTables[kind])} SET state=${state},version=${version},updated_at=clock_timestamp() ${state === 'completed' ? sql`,completed_at=clock_timestamp()` : state === 'approved' ? sql`,approved_at=clock_timestamp()` : sql``} WHERE tenant_id=${ctx.actor.tenant_id} AND id=${ref.id}`,
          );
          if (kind === 'expense_claim' && state === 'pending_finance')
            await this.createTask(
              tx,
              ctx.actor,
              { ...ref, version },
              head.owner_id,
              head.department_id,
              'finance',
              task.submission_id,
            );
          if (
            kind === 'expense_claim' &&
            (state === 'returned' || state === 'completed')
          )
            await settleOaBudget(
              tx,
              ctx.actor,
              ref.id,
              task.submission_id,
              state === 'completed' ? 'consume' : 'release',
            );
        } else if (operation.endsWith('.withdraw')) {
          state = 'withdrawn';
          const task = await this.currentTask(tx, ctx.actor, ref, true);
          await tx.execute(
            sql`UPDATE approval_tasks SET state='cancelled',version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${task.id}`,
          );
          await tx.execute(
            sql`UPDATE ${sql.raw(documentTables[kind])} SET state='withdrawn',version=${version},updated_at=clock_timestamp() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${ref.id}`,
          );
          if (kind === 'expense_claim')
            await settleOaBudget(
              tx,
              ctx.actor,
              ref.id,
              task.submission_id,
              'release',
            );
        } else {
          state = 'pending_manager';
          const submissionId = randomUUID();
          const body = await this.documents.project(tx, kind, head),
            snapshotId = await snapshot(tx, ctx.actor, ref, body);
          if (kind === 'expense_claim')
            await reserveOaBudget(tx, ctx.actor, ref.id, submissionId);
          await tx.execute(
            sql`UPDATE ${sql.raw(documentTables[kind])} SET state=${state},version=${version},submission_id=${submissionId},submitted_snapshot_id=${snapshotId},submitted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=${ctx.actor.tenant_id} AND id=${ref.id}`,
          );
          await this.createTask(
            tx,
            ctx.actor,
            { ...ref, version },
            head.owner_id,
            head.department_id,
            'manager',
            submissionId,
          );
        }
        await recordDocumentEvent(
          tx as import('@caixiaozhi/platform/database').Transaction,
          ctx.actor,
          kind,
          ref.id,
          version,
          `${kind}.state_changed`,
        );
        return this.receipt(ctx, action, tx, { ...ref, version });
      },
      queryOutcome: async (ctx) => {
        const [entry] = await rows<{ receipt: ActionReceipt }>(
          this.documents.database.db,
          sql`SELECT receipt FROM business_receipts WHERE tenant_id=${ctx.actor.tenant_id} AND action_id=${ctx.action_id} AND item_id=${ctx.item_id}`,
        );
        return (
          entry?.receipt ?? {
            id: randomUUID(),
            action_id: ctx.action_id,
            idempotency_key: ctx.idempotency_key,
            outcome: 'unknown',
            resource: null,
            external_receipt_id: ctx.external_request_id,
            occurred_at: new Date().toISOString(),
            data_mode: 'demo',
            error_code: 'OUTCOME_UNKNOWN',
          }
        );
      },
    };
  }
}
