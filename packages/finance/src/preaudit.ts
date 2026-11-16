import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  SrsInputSnapshotSchema,
  type SrsInput,
  type ReviewerPurpose,
} from '@caixiaozhi/contracts/rules';
import {
  StartPreauditSchema,
  PreauditResultSchema,
  type StartPreauditCommand,
  type PreauditCoverage,
  type PreauditFinding,
  type PreauditResult,
  type PreauditTaskAccepted,
  type PreauditTaskView,
  type PreauditVersionLock,
} from '@caixiaozhi/contracts/preaudit';
import type {
  EligibilityProof,
  ManualReviewAck,
  PreauditEligibilityInput,
} from '@caixiaozhi/contracts/preaudit-eligibility';
import { ManualReviewAckSchema } from '@caixiaozhi/contracts/preaudit-eligibility';
import type {
  DatabaseConnection,
  DatabaseExecutor,
} from '@caixiaozhi/platform/database';
import { AppError } from '@caixiaozhi/platform/errors';
import type { FinanceOptions, ApprovalTaskSnapshot } from './ports.js';
import type { DurableJob } from '@caixiaozhi/jobs/queue';
import { RuleService, type ResolvedRuleSet } from './rules.js';
import { evaluateRule, evaluatePredicate } from './evaluator.js';
import { canonicalHash } from './hash.js';
import {
  assertDomainLease,
  command,
  iso,
  json,
  nowIso,
  outbox,
  rows,
} from './database.js';
const notFound = () => new AppError('NOT_FOUND', '请求的预审资源不存在。');
export function evaluateSnapshot(input: SrsInput, rules: ResolvedRuleSet) {
  const coverage: PreauditCoverage = {
    company_required_total: 0,
    company_known_total: 0,
    company_unknown_total: 0,
    company_not_applicable_total: 0,
    company_missing_evidence_total: 0,
    personal_selected_total: rules.personal.length,
    personal_known_total: 0,
    personal_unknown_total: 0,
    missing_fields: [],
    failed_dependencies: [],
  };
  const findings: PreauditFinding[] = [];
  for (const [level, list] of [
    ['company', rules.company],
    ['personal', rules.personal],
  ] as const) {
    for (const rule of list) {
      const applicable = rule.compiled.dsl.applicability.condition
        ? evaluatePredicate(rule.compiled.dsl.applicability.condition, input)
        : {
            truth: 'true' as const,
            field_refs: [],
            unknown_reasons: [],
            trace: [],
          };
      if (applicable.truth === 'false') {
        if (level === 'company') coverage.company_not_applicable_total++;
        else coverage.personal_known_total++;
        continue;
      }
      if (level === 'company') coverage.company_required_total++;
      const evaluated =
        applicable.truth === 'unknown'
          ? applicable
          : rule.source_review_required
            ? {
                truth: 'unknown' as const,
                field_refs: [],
                unknown_reasons: ['SOURCE_REVIEW_REQUIRED'],
                trace: [],
              }
            : evaluateRule(rule.compiled, input);
      if (evaluated.truth === 'unknown') {
        if (level === 'company') coverage.company_unknown_total++;
        else coverage.personal_unknown_total++;
        coverage.missing_fields.push(...evaluated.field_refs);
        coverage.failed_dependencies.push(...evaluated.unknown_reasons);
      } else if (level === 'company') coverage.company_known_total++;
      else coverage.personal_known_total++;
      const kind =
        evaluated.truth === 'unknown'
          ? level === 'company'
            ? 'unresolved_required'
            : 'unresolved_personal'
          : level === 'personal'
            ? evaluated.truth === 'true'
              ? 'personal_attention'
              : null
            : evaluated.truth === 'false'
              ? rule.compiled.dsl.outcome_mode === 'mandatory_check' &&
                rule.compiled.dsl.failure_kind === 'missing_evidence'
                ? 'company_missing_evidence'
                : 'company_violation'
              : null;
      if (kind) {
        if (kind === 'company_missing_evidence')
          coverage.company_missing_evidence_total++;
        findings.push({
          id: randomUUID(),
          rule_ref: { type: 'rule', id: rule.id, version: rule.version_number },
          kind,
          truth: evaluated.truth,
          field_refs: evaluated.field_refs,
          actual: { trace: evaluated.trace },
          expected: { predicate: rule.compiled.dsl.predicate },
          citation_refs: rule.source_citation_ids,
          message:
            kind === 'company_violation'
              ? `${rule.name}：已确认不符合要求。`
              : kind === 'personal_attention'
                ? `${rule.name}：命中本人的关注提醒。`
                : `${rule.name}：材料、来源或必要字段尚无法判断。`,
        });
      }
    }
  }
  if (!rules.coverage_complete) {
    coverage.failed_dependencies.push('MODULE_COVERAGE_UNCONFIGURED');
    findings.push({
      id: randomUUID(),
      rule_ref: null,
      kind: 'unresolved_required',
      truth: 'unknown',
      field_refs: [],
      actual: null,
      expected: null,
      citation_refs: [],
      message: '该类型尚未配置完整预审覆盖，不能判断为低风险。',
    });
  }
  coverage.missing_fields = [...new Set(coverage.missing_fields)];
  coverage.failed_dependencies = [...new Set(coverage.failed_dependencies)];
  const group = findings.some((f) => f.kind === 'company_violation')
    ? 'risk'
    : findings.some((f) =>
          [
            'company_missing_evidence',
            'unresolved_required',
            'unresolved_personal',
          ].includes(f.kind),
        )
      ? 'incomplete'
      : findings.some((f) => f.kind === 'personal_attention')
        ? 'attention'
        : 'low';
  return { group, coverage, findings } as const;
}
export class PreauditService {
  constructor(
    readonly database: DatabaseConnection,
    readonly options: FinanceOptions,
    readonly rules: RuleService,
  ) {}
  private async authorizePurpose(
    ctx: ActorContext,
    input: SrsInput,
    purpose: ReviewerPurpose,
    tx?: DatabaseExecutor,
  ): Promise<ApprovalTaskSnapshot | null> {
    const current = await this.options.identity.requireCurrentActor(ctx);
    if (purpose === 'employee_precheck') {
      if (input.applicant_id !== current.user_id) throw notFound();
      return null;
    }
    await this.options.identity.assertPermission(current, 'approval.decide');
    const task = await this.options.business.getApprovalTask(
      current,
      input.document,
      tx,
    );
    const scope = await this.options.identity.getResourceScope(
      current,
      'approval.decide',
    );
    if (
      !task ||
      task.assigned_to !== current.user_id ||
      task.status !== 'pending' ||
      task.stage !== (purpose === 'manager_review' ? 'manager' : 'finance') ||
      !scope.assigned_task_department_ids.includes(input.department_id)
    )
      throw notFound();
    return task;
  }
  async startPreaudit(
    ctx: ActorContext,
    input: StartPreauditCommand,
    key: string,
    originRunId: string | null = null,
    retryOfTaskId: string | null = null,
  ): Promise<PreauditTaskAccepted> {
    const current = await this.options.identity.requireCurrentActor(ctx),
      parsed = StartPreauditSchema.parse(input);
    for (const ref of parsed.documents) {
      const snapshot = SrsInputSnapshotSchema.parse(
        await this.options.business.getPreauditInput(
          current,
          ref.id,
          ref.version,
        ),
      );
      await this.authorizePurpose(current, snapshot.input, parsed.purpose);
    }
    const generation = (await this.options.identity.getMe(current)).generation;
    return command(
      this.database,
      current,
      'preaudit.start',
      key,
      { ...parsed, retry_of_task_id: retryOfTaskId },
      async (tx) => {
        const id = randomUUID();
        await tx.execute(
          sql`INSERT INTO preaudit_tasks(tenant_id,id,owner_id,purpose,scope_hash,selection_json,actor_reference,status,origin_run_id,retry_of_task_id) VALUES(${ctx.tenant_id},${id},${ctx.user_id},${parsed.purpose},${canonicalHash({ actor: ctx.user_id, authz: ctx.authz_version, purpose: parsed.purpose, departments: ctx.department_ids })},${json(parsed.documents)}::jsonb,${json(current)}::jsonb,'queued',${originRunId},${retryOfTaskId})`,
        );
        for (const ref of parsed.documents) {
          const itemId = randomUUID();
          await tx.execute(
            sql`INSERT INTO preaudit_items(tenant_id,id,task_id,document_type,document_id,requested_version,status) VALUES(${ctx.tenant_id},${itemId},${id},${ref.type},${ref.id},${ref.version},'pending')`,
          );
          if (this.options.jobs) {
            const job = await this.options.jobs.enqueueInTransaction(tx, {
              tenant_id: ctx.tenant_id,
              owner_module: 'preaudit',
              kind: 'preaudit.item',
              payload_ref: itemId,
              dedupe_key: itemId,
              generation,
            });
            await tx.execute(
              sql`UPDATE preaudit_items SET job_id=${job.id} WHERE tenant_id=${ctx.tenant_id} AND id=${itemId}`,
            );
          }
        }
        return {
          task_id: id,
          status: 'queued',
          total: parsed.documents.length,
          origin_run_id: originRunId,
          poll_after_ms: 500,
        };
      },
    );
  }
  private async buildLock(
    ctx: ActorContext,
    snapshot: ReturnType<typeof SrsInputSnapshotSchema.parse>,
    purpose: ReviewerPurpose,
    ruleSet: ResolvedRuleSet,
    task: ApprovalTaskSnapshot | null,
  ): Promise<PreauditVersionLock> {
    const p = snapshot.provenance;
    return {
      document_ref: snapshot.input.document,
      materials_version: p.materials_version,
      invoice_versions: p.invoice_versions,
      external_refs: p.external_refs,
      company_ruleset_revision: ruleSet.company_revision,
      company_rule_refs: ruleSet.company.map((r) => ({
        type: 'rule',
        id: r.id,
        version: r.version_number,
      })),
      personal_ruleset_revision: ruleSet.personal_revision,
      personal_rule_refs: ruleSet.personal.map((r) => ({
        type: 'rule',
        id: r.id,
        version: r.version_number,
      })),
      field_catalog_version: p.field_catalog_version,
      mapping_versions: p.mapping_versions,
      policy_refs: [],
      reviewer_id: ctx.user_id,
      reviewer_purpose: purpose,
      reviewer_scope_hash: canonicalHash({
        tenant: ctx.tenant_id,
        user: ctx.user_id,
        department_ids: ctx.department_ids,
        permissions: ctx.permissions,
        purpose,
      }),
      authz_version: ctx.authz_version,
      approval_task_id: task?.id ?? null,
      approval_task_version: task?.version ?? null,
      effective_basis:
        purpose === 'employee_precheck' ? 'evaluation_date' : 'submitted_date',
      basis_date: snapshot.input.business_date,
    };
  }
  async processItem(
    tenantId: string,
    itemId: string,
    job?: DurableJob,
  ): Promise<void> {
    if (job) await assertDomainLease(this.database.db, job);
    const selected = await rows<any>(
      this.database.db,
      sql`SELECT i.*,t.actor_reference,t.purpose,t.cancel_requested FROM preaudit_items i JOIN preaudit_tasks t ON t.tenant_id=i.tenant_id AND t.id=i.task_id WHERE i.tenant_id=${tenantId} AND i.id=${itemId}`,
    );
    const item = selected[0];
    if (
      !item ||
      item.result_id ||
      item.status === 'failed' ||
      item.cancel_requested
    )
      return;
    const ctx = item.actor_reference as ActorContext;
    try {
      await this.options.identity.requireCurrentActor(ctx);
      const mayRun = await this.database.db.transaction(async (tx) => {
        if (job) await assertDomainLease(tx, job);
        const active = await rows<{ cancel_requested: boolean }>(
          tx,
          sql`SELECT cancel_requested FROM preaudit_tasks WHERE tenant_id=${tenantId} AND id=${item.task_id} FOR UPDATE`,
        );
        if (active[0]?.cancel_requested) return false;
        await tx.execute(
          sql`UPDATE preaudit_tasks SET status='running',updated_at=now() WHERE tenant_id=${tenantId} AND id=${item.task_id} AND status='queued'`,
        );
        await tx.execute(
          sql`UPDATE preaudit_items SET status='running',attempt=attempt+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${itemId} AND result_id IS NULL AND skipped_reason IS NULL`,
        );
        return true;
      });
      if (!mayRun) return;
      const snapshot = SrsInputSnapshotSchema.parse(
        await this.options.business.getPreauditInput(
          ctx,
          item.document_id,
          item.requested_version,
        ),
      );
      if (canonicalHash(snapshot.input) !== snapshot.provenance.input_hash)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '业务输入与来源校验和不一致。',
        );
      const approval = await this.authorizePurpose(
        ctx,
        snapshot.input,
        item.purpose,
      );
      const ruleSet = await this.rules.resolveRuleSet(
        ctx,
        snapshot.input,
        item.purpose,
        snapshot.input.business_date,
      );
      const lock = await this.buildLock(
        ctx,
        snapshot,
        item.purpose,
        ruleSet,
        approval,
      );
      for (const r of [...ruleSet.company, ...ruleSet.personal])
        for (const citation of r.source_citation_ids) {
          try {
            const source = await this.rules.knowledge.getCitation(
              ctx,
              citation,
            );
            if (
              !lock.policy_refs.some(
                (p) =>
                  p.id === source.policy_ref.id &&
                  p.version === source.policy_ref.version,
              )
            )
              lock.policy_refs.push(source.policy_ref);
          } catch {
            /* 来源失效由确定性规则保留为unknown，不丢弃整个结果。 */
          }
        }
      const evaluated = evaluateSnapshot(snapshot.input, ruleSet);
      const resultId = randomUUID();
      const result: PreauditResult = {
        result_id: resultId,
        document_ref: snapshot.input.document,
        status: 'completed',
        group: evaluated.group,
        amount: snapshot.input.total_amount,
        coverage: evaluated.coverage,
        eligible_for_bulk_approval:
          evaluated.group === 'low' &&
          item.purpose !== 'employee_precheck' &&
          approval !== null,
        eligibility_reasons:
          item.purpose === 'employee_precheck'
            ? ['EMPLOYEE_PRECHECK_ONLY']
            : evaluated.group !== 'low'
              ? ['NOT_LOW_RISK']
              : [],
        findings: evaluated.findings,
        snapshot_at: nowIso(),
        locked_versions: lock,
        lock_hash: canonicalHash(lock),
        result_hash: '',
        task_ref: approval
          ? { id: approval.id, version: approval.version }
          : null,
        purpose: item.purpose,
        reviewer_id: ctx.user_id,
      };
      result.result_hash = canonicalHash({ ...result, result_hash: undefined });
      const fresh = await this.freshness(ctx, result);
      if (fresh.length) {
        result.status = 'stale';
        result.eligible_for_bulk_approval = false;
        result.eligibility_reasons = fresh;
      }
      await this.database.db.transaction(async (tx) => {
        if (job) await assertDomainLease(tx, job);
        const liveTask = await rows<{ cancel_requested: boolean }>(
          tx,
          sql`SELECT cancel_requested FROM preaudit_tasks WHERE tenant_id=${tenantId} AND id=${item.task_id} FOR SHARE`,
        );
        if (liveTask[0]?.cancel_requested) return;
        await tx.execute(
          sql`SELECT id FROM preaudit_items WHERE tenant_id=${tenantId} AND id=${itemId} FOR UPDATE`,
        );
        const existing = await rows<any>(
          tx,
          sql`SELECT result_id FROM preaudit_items WHERE tenant_id=${tenantId} AND id=${itemId}`,
        );
        if (existing[0]?.result_id) return;
        const finalReasons = await this.freshness(ctx, result, tx, true);
        if (finalReasons.length) {
          result.status = 'stale';
          result.eligible_for_bulk_approval = false;
          result.eligibility_reasons = finalReasons;
        }
        await tx.execute(
          sql`INSERT INTO preaudit_results(tenant_id,id,item_id,reviewer_id,input_snapshot,locked_versions,lock_hash,result_hash,result_json) VALUES(${tenantId},${resultId},${itemId},${ctx.user_id},${json(snapshot)}::jsonb,${json(lock)}::jsonb,${result.lock_hash},${result.result_hash},${json(result)}::jsonb)`,
        );
        await tx.execute(
          sql`UPDATE preaudit_items SET status=${result.status},result_id=${resultId},last_error=NULL,version=version+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${itemId}`,
        );
        await outbox(
          tx,
          ctx,
          'preaudit.result_created',
          snapshot.input.document.type,
          snapshot.input.document.id,
          snapshot.input.document.version,
          { result_id: resultId, task_id: item.task_id, group: result.group },
        );
      });
    } catch (error) {
      const known =
        error instanceof AppError
          ? error
          : new AppError(
              'DEPENDENCY_UNAVAILABLE',
              '预审读取或规则执行失败，请重试。',
            );
      if (known.details?.reason === 'LEASE_LOST') throw known;
      await this.database.db.transaction(async (tx) => {
        if (job) await assertDomainLease(tx, job);
        await tx.execute(
          sql`UPDATE preaudit_items SET status='failed',last_error=${json({ code: known.code, message: known.message, retryable: known.retryable })}::jsonb,version=version+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${itemId} AND result_id IS NULL`,
        );
      });
    }
    await this.aggregate(tenantId, item.task_id);
  }
  private async aggregate(tenantId: string, taskId: string) {
    const counts = await rows<any>(
      this.database.db,
      sql`SELECT count(*) FILTER(WHERE status IN ('completed','stale'))::int AS completed,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status IN ('pending','running') AND skipped_reason IS NULL)::int AS remaining FROM preaudit_items WHERE tenant_id=${tenantId} AND task_id=${taskId}`,
    );
    const c = counts[0];
    if (!c.remaining)
      await this.database.db.execute(
        sql`UPDATE preaudit_tasks SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE ${c.failed ? (c.completed ? 'partial_failed' : 'failed') : 'completed'} END,version=version+1,updated_at=now() WHERE tenant_id=${tenantId} AND id=${taskId}`,
      );
  }
  private async freshness(
    ctx: ActorContext,
    result: PreauditResult,
    tx: DatabaseExecutor = this.database.db,
    locked = false,
  ): Promise<string[]> {
    const reasons: string[] = [];
    const current = await this.options.identity.requireCurrentActor(ctx);
    if (result.reviewer_id !== current.user_id) throw notFound();
    let snapshot: ReturnType<typeof SrsInputSnapshotSchema.parse>;
    try {
      snapshot = SrsInputSnapshotSchema.parse(
        await this.options.business.getPreauditInput(
          current,
          result.document_ref.id,
          result.document_ref.version,
          tx,
        ),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'VERSION_CONFLICT')
        return ['DOCUMENT_CHANGED'];
      throw error;
    }
    const p = snapshot.provenance,
      l = result.locked_versions;
    if (l.authz_version !== current.authz_version)
      reasons.push('AUTHZ_CHANGED');
    if (
      p.materials_version !== l.materials_version ||
      canonicalHash(p.invoice_versions) !== canonicalHash(l.invoice_versions)
    )
      reasons.push('MATERIALS_CHANGED');
    if (
      canonicalHash(p.mapping_versions) !== canonicalHash(l.mapping_versions) ||
      p.field_catalog_version !== l.field_catalog_version
    )
      reasons.push('MAPPING_CHANGED');
    if (canonicalHash(p.external_refs) !== canonicalHash(l.external_refs))
      reasons.push('EXTERNAL_SOURCE_CHANGED');
    const set = await this.rules.resolveRuleSet(
      current,
      snapshot.input,
      result.purpose,
      l.basis_date,
      tx,
      locked,
    );
    if (
      set.company_revision !== l.company_ruleset_revision ||
      set.personal_revision !== l.personal_ruleset_revision
    )
      reasons.push('RULESET_CHANGED');
    const task = await this.options.business.getApprovalTask(
      current,
      result.document_ref,
      tx,
    );
    if (
      (task?.id ?? null) !== l.approval_task_id ||
      (task?.version ?? null) !== l.approval_task_version ||
      (task &&
        (task.assigned_to !== current.user_id || task.status !== 'pending'))
    )
      reasons.push('APPROVAL_NODE_CHANGED');
    for (const rule of [...set.company, ...set.personal])
      if (rule.source_review_required) reasons.push('POLICY_SOURCE_CHANGED');
    return [...new Set(reasons)];
  }
  async getResult(
    ctx: ActorContext,
    id: string,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<PreauditResult> {
    await this.options.identity.requireCurrentActor(ctx);
    const found = await rows<any>(
      tx,
      sql`SELECT * FROM preaudit_results WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND reviewer_id=${ctx.user_id}`,
    );
    if (!found[0]) throw notFound();
    const result = PreauditResultSchema.parse(found[0].result_json);
    let reasons: string[] = [];
    try {
      reasons = await this.freshness(ctx, result, tx);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') throw error;
      reasons = [error instanceof AppError ? error.code : 'SOURCE_UNAVAILABLE'];
    }
    if (reasons.length) {
      await tx.execute(
        sql`UPDATE preaudit_items SET status='stale',updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND result_id=${id}`,
      );
      return {
        ...result,
        status: 'stale',
        eligible_for_bulk_approval: false,
        eligibility_reasons: reasons,
      };
    }
    return result;
  }
  async getTask(ctx: ActorContext, id: string): Promise<PreauditTaskView> {
    await this.options.identity.requireCurrentActor(ctx);
    const tasks = await rows<any>(
      this.database.db,
      sql`SELECT * FROM preaudit_tasks WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND owner_id=${ctx.user_id}`,
    );
    const task = tasks[0];
    if (!task) throw notFound();
    const selected = await rows<any>(
      this.database.db,
      sql`SELECT * FROM preaudit_items WHERE tenant_id=${ctx.tenant_id} AND task_id=${id} ORDER BY document_id,id`,
    );
    const counts = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      stale: 0,
    };
    const groups = {
      risk: {
        count: 0,
        amount: { amount_minor: '0', currency: 'CNY' as const },
      },
      incomplete: {
        count: 0,
        amount: { amount_minor: '0', currency: 'CNY' as const },
      },
      attention: {
        count: 0,
        amount: { amount_minor: '0', currency: 'CNY' as const },
      },
      low: {
        count: 0,
        amount: { amount_minor: '0', currency: 'CNY' as const },
      },
    };
    let total = 0n;
    const items: PreauditTaskView['items'] = [];
    for (const row of selected) {
      const result = row.result_id
        ? await this.getResult(ctx, row.result_id)
        : null;
      const status = result?.status === 'stale' ? 'stale' : row.status;
      counts[status as keyof typeof counts]++;
      if (result) {
        const g = groups[result.group];
        g.count++;
        g.amount.amount_minor = (
          BigInt(g.amount.amount_minor) +
          BigInt(result.amount?.amount_minor ?? '0')
        ).toString();
        total += BigInt(result.amount?.amount_minor ?? '0');
      }
      items.push({
        id: row.id,
        document_ref: {
          type: row.document_type,
          id: row.document_id,
          version: row.requested_version,
        },
        status,
        result_id: row.result_id,
        result,
        last_error: row.last_error,
        skipped_reason: row.skipped_reason,
      });
    }
    return {
      task: {
        id: task.id,
        tenant_id: task.tenant_id,
        owner_id: task.owner_id,
        version: task.version,
        purpose: task.purpose,
        status: task.status,
        origin_run_id: task.origin_run_id,
        total: selected.length,
        created_at: iso(task.created_at),
        updated_at: iso(task.updated_at),
      },
      counts,
      items,
      next_cursor: null,
      summary: {
        total_amount: { amount_minor: total.toString(), currency: 'CNY' },
        groups,
      },
    };
  }
  async bulkCandidates(ctx: ActorContext, taskId: string) {
    const task = await this.getTask(ctx, taskId);
    const items = task.items
      .filter((i) => i.result?.eligible_for_bulk_approval)
      .map((i) => ({
        result_id: i.result!.result_id,
        document_ref: i.document_ref,
        task_ref: i.result!.task_ref,
        purpose: i.result!.purpose,
        result_hash: i.result!.result_hash,
        lock_hash: i.result!.lock_hash,
        amount: i.result!.amount,
      }));
    return {
      items,
      total_amount: {
        amount_minor: items
          .reduce((sum, i) => sum + BigInt(i.amount?.amount_minor ?? '0'), 0n)
          .toString(),
        currency: 'CNY',
      },
      excluded: task.items
        .filter((i) => !i.result?.eligible_for_bulk_approval)
        .map((i) => ({
          document_ref: i.document_ref,
          reasons: i.result?.eligibility_reasons ?? ['NOT_COMPLETED'],
        })),
    };
  }
  async check(
    ctx: ActorContext,
    input: PreauditEligibilityInput,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<EligibilityProof> {
    const result = await this.getResult(ctx, input.preaudit_result_id, tx);
    let reasons = await this.freshness(ctx, result, tx, true);
    if (result.group !== 'low' || !result.eligible_for_bulk_approval)
      reasons.push('NOT_ELIGIBLE');
    if (
      input.resource_ref.id !== result.document_ref.id ||
      input.resource_ref.version !== result.document_ref.version ||
      input.resource_ref.type !== result.document_ref.type
    )
      reasons.push('DOCUMENT_CHANGED');
    if (
      input.expected_purpose !== result.purpose ||
      input.task_ref.id !== result.task_ref?.id ||
      input.task_ref.version !== result.task_ref?.version
    )
      reasons.push('REVIEW_SCOPE_CHANGED');
    if (
      input.expected_guards &&
      (input.expected_guards.lock_hash !== result.lock_hash ||
        input.expected_guards.result_hash !== result.result_hash)
    )
      reasons.push('PROOF_CHANGED');
    return {
      eligible: reasons.length === 0,
      result_id: result.result_id,
      reviewer_id: result.reviewer_id,
      result_hash: result.result_hash,
      lock_hash: result.lock_hash,
      locked_versions: result.locked_versions,
      checked_at: nowIso(),
      rejection_reasons: [...new Set(reasons)],
    };
  }
  async validateManualReview(
    ctx: ActorContext,
    ref: ResourceRef,
    ack: ManualReviewAck | null | undefined,
    reason: string | null | undefined,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<void> {
    if (!ack)
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '请先查看当前预审并确认人工审核意见。',
      );
    const result = await this.getResult(ctx, ack.preaudit_result_id, tx);
    const stale = await this.freshness(ctx, result, tx, true);
    if (
      stale.length ||
      result.document_ref.id !== ref.id ||
      result.document_ref.version !== ref.version ||
      result.lock_hash !== ack.lock_hash ||
      result.result_hash !== ack.result_hash ||
      result.purpose === 'employee_precheck'
    )
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '预审、材料或审核范围已更新，请重新查看。',
      );
    ManualReviewAckSchema.parse(ack);
    if (
      result.group !== 'low' &&
      (!reason?.trim() ||
        result.findings.some(
          (f) => !ack.acknowledged_finding_ids.includes(f.id),
        ))
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '请明确确认全部预审发现，并填写人工审核理由。',
      );
  }
  async cancelTask(
    ctx: ActorContext,
    id: string,
    expected: number,
    key: string,
  ) {
    await this.getTask(ctx, id);
    return command(
      this.database,
      ctx,
      'preaudit.cancel',
      key,
      { id, expected },
      async (tx) => {
        const updated = await rows(
          tx,
          sql`UPDATE preaudit_tasks SET cancel_requested=true,status='cancelled',version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${expected} AND status IN ('queued','running') RETURNING id`,
        );
        if (!updated[0])
          throw new AppError('VERSION_CONFLICT', '预审状态已更新，请刷新。');
        await tx.execute(
          sql`UPDATE preaudit_items SET skipped_reason='task_cancelled',status='pending',updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND task_id=${id} AND status IN ('pending','running') AND result_id IS NULL`,
        );
        return { task_id: id, status: 'cancelled' };
      },
    );
  }
  async retryTask(
    ctx: ActorContext,
    id: string,
    expected: number,
    failedIds: string[],
    key: string,
  ): Promise<PreauditTaskAccepted> {
    const original = await this.getTask(ctx, id);
    if (original.task.version !== expected)
      throw new AppError('VERSION_CONFLICT', '原任务状态已更新，请刷新。');
    if (
      !failedIds.length ||
      new Set(failedIds).size !== failedIds.length ||
      failedIds.some(
        (itemId) =>
          !original.items.some(
            (item) => item.id === itemId && item.status === 'failed',
          ),
      )
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '只能选择原任务中失败的项目重试。',
      );
    const selected = original.items.filter((item) =>
      failedIds.includes(item.id),
    );
    const current =
      original.task.purpose === 'employee_precheck'
        ? []
        : await this.options.business.listCurrentApprovalDocuments(ctx);
    const documents = selected.map(
      (item) =>
        current.find(
          (ref) =>
            ref.type === item.document_ref.type &&
            ref.id === item.document_ref.id,
        ) ?? item.document_ref,
    );
    return this.startPreaudit(
      ctx,
      StartPreauditSchema.parse({ purpose: original.task.purpose, documents }),
      key,
      original.task.origin_run_id,
      id,
    );
  }
}
