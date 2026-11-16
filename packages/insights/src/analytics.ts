import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import {
  QueryPlanSchema,
  EditableBlocksSchema,
  ExportCommandSchema,
  ReportTemplateSchema,
  type QueryPlan,
  type MetricDefinition,
  type AnalysisFact,
} from '@caixiaozhi/contracts/analytics';
import type { Database, DatabaseExecutor } from '@caixiaozhi/platform/database';
import type { Storage } from '@caixiaozhi/platform/storage';
import { AppError } from '@caixiaozhi/platform/errors';
import { hashPayload } from '@caixiaozhi/action-service';
import {
  assertJob,
  claimInsightJob,
  enqueueJob,
  finishJob,
  json,
  startJobHeartbeat,
  writeCommand,
  type Row,
} from './shared.js';
export type AnalyticsScope = {
  tenant_id: string;
  owner_ids: string[];
  department_ids: string[];
};
export type AnalyticsOptions = {
  freshActor(actor: ActorContext): Promise<ActorContext>;
  getResourceScope(
    actor: ActorContext,
    operation: string,
  ): Promise<AnalyticsScope>;
  businessDate?: () => Promise<string>;
  storage?: Pick<Storage, 'putObject' | 'getObject'>;
  lowCandidates?: (
    actor: ActorContext,
    refs: Array<{ id: string; version: number }>,
    tx: DatabaseExecutor,
  ) => Promise<{
    eligible_ids: string[];
    checked_count: number;
    unchecked_count: number;
  }>;
};
const catalogVersion = 'finance-metrics-v1';
const dims = [
  'applicant',
  'department',
  'expense_type',
  'completed_day',
  'completed_month',
  'submitted_day',
  'submitted_month',
] as const;
export const METRIC_CATALOG: MetricDefinition[] =
  QueryPlanSchema.shape.metric.options.map((metric_id) => ({
    metric_id,
    grain:
      metric_id.includes('category_') || metric_id.includes('entertainment_')
        ? 'line'
        : 'claim',
    unit: metric_id.endsWith('_count') ? 'count' : 'CNY_minor',
    date_basis:
      metric_id.includes('pending_') || metric_id.includes('low_')
        ? 'snapshot_at'
        : metric_id.includes('submitted_')
          ? 'submitted_at'
          : 'completed_at',
    allowed_dimensions:
      metric_id.includes('pending_') || metric_id.includes('low_')
        ? ['applicant', 'department']
        : metric_id.includes('submitted_')
          ? ['applicant', 'department', 'submitted_day', 'submitted_month']
          : metric_id.includes('category_') ||
              metric_id.includes('entertainment_')
            ? [
                'applicant',
                'department',
                'expense_type',
                'completed_day',
                'completed_month',
              ]
            : ['applicant', 'department', 'completed_day', 'completed_month'],
    catalog_version: catalogVersion,
  }));
export function percentageChange(
  current: bigint,
  base: bigint,
): { rate_percent: string | null; reason: string | null } {
  if (base === 0n) return { rate_percent: null, reason: 'zero_baseline' };
  const delta = current - base,
    negative = delta < 0n,
    numerator = (negative ? -delta : delta) * 10000n,
    rounded = (numerator + base / 2n) / base;
  return {
    rate_percent: `${negative ? '-' : ''}${rounded / 100n}.${String(rounded % 100n).padStart(2, '0')}`,
    reason: null,
  };
}
export const shanghaiUtcBoundary = (date: string) =>
  new Date(`${z.iso.date().parse(date)}T00:00:00+08:00`).toISOString();
const localDate = (time: string | null) =>
  time
    ? new Date(new Date(time).getTime() + 28800000).toISOString().slice(0, 10)
    : '';
const asTime = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;
const money = (value: bigint) => ({
  amount_minor: String(value),
  currency: 'CNY' as const,
});
const escapeHtml = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const csvText = (s: unknown) => {
  let v = String(s ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replaceAll('"', '""')}"`;
};
type Group = {
  dimension_key: string;
  label: string;
  value: string;
  fact_refs: string[];
};
type SnapshotBody = {
  id: string;
  version: number;
  metric: string;
  total: ReturnType<typeof money> | { count: number };
  comparison: null | {
    base: ReturnType<typeof money>;
    delta: ReturnType<typeof money>;
    rate_percent: string | null;
    reason: string | null;
  };
  rows: Group[];
  chart: unknown;
  quality: 'ready' | 'empty' | 'degraded';
  quality_notes: string[];
  snapshot_at: string;
  plan_hash: string;
  source_watermark: string;
  scope_label: string;
  period_label: string;
  evidence_refs: string[];
  checked_count: number | null;
  unchecked_count: number | null;
};
export function createAnalyticsService(
  database: Database,
  options: AnalyticsOptions,
) {
  async function fresh(actor: ActorContext) {
    const a = await options.freshActor(actor);
    if (
      a.tenant_id !== actor.tenant_id ||
      a.user_id !== actor.user_id ||
      !a.permissions.includes('analytics.query')
    )
      throw new AppError('FORBIDDEN', '无费用分析权限。');
    return a;
  }
  async function validatePlan(
    actor: ActorContext,
    input: unknown,
  ): Promise<{ actor: ActorContext; plan: QueryPlan; scope: AnalyticsScope }> {
    const a = await fresh(actor),
      plan = QueryPlanSchema.parse(input),
      definition = METRIC_CATALOG.find((m) => m.metric_id === plan.metric)!;
    if (
      plan.period.date_basis !== definition.date_basis ||
      plan.dimensions.some((d) => !definition.allowed_dimensions.includes(d))
    )
      throw new AppError('VALIDATION_ERROR', '指标、维度与日期口径不兼容。', {
        details: { reason: 'INCOMPATIBLE_DIMENSION' },
      });
    if (new Set(plan.dimensions).size !== plan.dimensions.length)
      throw new AppError('VALIDATION_ERROR', '维度不能重复。');
    if ('from' in plan.period) {
      for (const p of [
        plan.period,
        ...(plan.period.compare_to ? [plan.period.compare_to] : []),
      ]) {
        const days =
          (Date.parse(p.to_exclusive) - Date.parse(p.from)) / 86400000;
        if (days <= 0 || days > 732)
          throw new AppError(
            'VALIDATION_ERROR',
            '日期范围必须大于零且不超过 24 个月。',
          );
      }
    }
    const allowed = await options.getResourceScope(a, 'analytics.query');
    if (allowed.tenant_id !== a.tenant_id)
      throw new AppError('FORBIDDEN', '授权范围不匹配。');
    let scope: AnalyticsScope;
    if (plan.filters.scope === 'self') {
      if (
        !allowed.owner_ids.includes(a.user_id) &&
        !allowed.department_ids.length
      )
        throw new AppError('FORBIDDEN', '无本人业务范围。');
      scope = {
        tenant_id: a.tenant_id,
        owner_ids: [a.user_id],
        department_ids: [],
      };
    } else {
      const requested = plan.filters.department_ids ?? allowed.department_ids;
      if (
        !requested.length ||
        requested.some((id) => !allowed.department_ids.includes(id))
      )
        throw new AppError('FORBIDDEN', '请求部门不在当前授权范围。');
      scope = {
        tenant_id: a.tenant_id,
        owner_ids: [],
        department_ids: [...new Set(requested)].sort(),
      };
    }
    if (
      plan.filters.scope === 'self' &&
      plan.filters.applicant_ids?.some((id) => id !== a.user_id)
    )
      throw new AppError('FORBIDDEN', '本人查询不能指定其他申请人。');
    return { actor: a, plan, scope };
  }
  async function assertScope(actor: ActorContext, scope: AnalyticsScope) {
    const a = await fresh(actor),
      allowed = await options.getResourceScope(a, 'analytics.query');
    if (
      scope.tenant_id !== a.tenant_id ||
      scope.owner_ids.some(
        (id) =>
          id !== a.user_id ||
          (!allowed.owner_ids.includes(id) && !allowed.department_ids.length),
      ) ||
      scope.department_ids.some((id) => !allowed.department_ids.includes(id))
    )
      throw new AppError('NOT_FOUND', '分析不存在或当前范围已失效。');
    return a;
  }
  async function readSource(
    tx: DatabaseExecutor,
    actor: ActorContext,
    scope: AnalyticsScope,
  ) {
    const claims = (
      await tx.execute(
        sql`SELECT id,owner_id,department_id,version,state,total_minor::text,submitted_at,completed_at FROM expense_claims WHERE tenant_id=${actor.tenant_id} AND (owner_id IN(SELECT jsonb_array_elements_text(${json(scope.owner_ids)})) OR department_id IN(SELECT jsonb_array_elements_text(${json(scope.department_ids)}))) ORDER BY id`,
      )
    ).rows;
    const ids = claims.map((c) => String(c.id));
    const lines = ids.length
      ? (
          await tx.execute(
            sql`SELECT e.id,e.claim_id,e.version,e.amount_minor::text,e.expense_type,e.data,o.version AS oa_version,o.state AS oa_state FROM expense_items e LEFT JOIN entertainment_requests o ON o.tenant_id=e.tenant_id AND o.id=e.data->'oa_ref'->>'id' WHERE e.tenant_id=${actor.tenant_id} AND e.claim_id IN(SELECT jsonb_array_elements_text(${json(ids)})) ORDER BY e.claim_id,e.id`,
          )
        ).rows
      : [];
    return {
      claims,
      lines,
      watermark: hashPayload({
        claims: claims.map((c) => ({
          ...c,
          submitted_at: asTime(c.submitted_at),
          completed_at: asTime(c.completed_at),
        })),
        lines,
      }),
    };
  }
  function selected(fact: AnalysisFact, plan: QueryPlan, compare = false) {
    if (
      plan.filters.applicant_ids &&
      !plan.filters.applicant_ids.includes(fact.applicant_id)
    )
      return false;
    if (
      plan.filters.expense_types &&
      (!fact.expense_type ||
        !plan.filters.expense_types.includes(fact.expense_type as never))
    )
      return false;
    if ('from' in plan.period) {
      const period = compare ? plan.period.compare_to : plan.period;
      if (!period) return false;
      const date = localDate(
        plan.period.date_basis === 'completed_at'
          ? fact.completed_at
          : fact.submitted_at,
      );
      return date >= period.from && date < period.to_exclusive;
    }
    return !compare;
  }
  function aggregate(
    facts: AnalysisFact[],
    plan: QueryPlan,
    eligible: Set<string>,
    compare = false,
  ) {
    const definition = METRIC_CATALOG.find((m) => m.metric_id === plan.metric)!;
    const used = facts.filter(
      (f) =>
        f.fact_kind === definition.grain &&
        selected(f, plan, compare) &&
        (definition.date_basis === 'completed_at'
          ? f.state === 'completed'
          : definition.date_basis === 'submitted_at'
            ? [
                'pending_manager',
                'pending_finance',
                'completed',
                'returned',
              ].includes(f.state)
            : f.state === 'pending_manager') &&
        (!plan.metric.includes('low_') || eligible.has(f.claim_ref.id)) &&
        (!plan.metric.includes('entertainment_') ||
          (f.expense_type === 'meals' && f.entertainment_valid === true)),
    );
    const groups = new Map<
      string,
      { label: string; value: bigint; refs: string[] }
    >();
    let total = 0n;
    for (const f of used) {
      const value = definition.unit === 'count' ? 1n : BigInt(f.amount_minor);
      total += value;
      const values = plan.dimensions.map((d) =>
        d === 'applicant'
          ? f.applicant_id
          : d === 'department'
            ? f.department_id
            : d === 'expense_type'
              ? (f.expense_type ?? '未知')
              : d === 'completed_day'
                ? localDate(f.completed_at)
                : d === 'completed_month'
                  ? localDate(f.completed_at).slice(0, 7)
                  : d === 'submitted_day'
                    ? localDate(f.submitted_at)
                    : localDate(f.submitted_at).slice(0, 7),
      );
      const key = JSON.stringify(values),
        group = groups.get(key) ?? {
          label: values.join(' / ') || '合计',
          value: 0n,
          refs: [],
        };
      group.value += value;
      group.refs.push(f.id);
      groups.set(key, group);
    }
    if (groups.size > 500)
      throw new AppError('VALIDATION_ERROR', '分组超过 500，请缩小范围。');
    let rows: Group[] = [...groups.entries()]
      .map(([dimension_key, g]) => ({
        dimension_key,
        label: g.label,
        value: String(g.value),
        fact_refs: g.refs,
      }))
      .sort((a, b) =>
        BigInt(a.value) === BigInt(b.value)
          ? a.dimension_key.localeCompare(b.dimension_key)
          : BigInt(a.value) > BigInt(b.value)
            ? -1
            : 1,
      );
    const top = plan.filters.top_n ?? 10;
    if (rows.length > top) {
      const rest = rows.slice(top);
      rows = [
        ...rows.slice(0, top),
        {
          dimension_key: '["__other__"]',
          label: '其他',
          value: String(rest.reduce((sum, r) => sum + BigInt(r.value), 0n)),
          fact_refs: rest.flatMap((r) => r.fact_refs),
        },
      ];
    }
    return { total, rows, used };
  }
  async function query(
    actor: ActorContext,
    input: unknown,
    key: string,
    context: { origin_run_id?: string | null } = {},
  ) {
    const checked = await validatePlan(actor, input);
    return writeCommand(
      database,
      checked.actor,
      'analytics.query',
      key,
      { plan: checked.plan },
      async (tx) => {
        const id = randomUUID(),
          jobId = await enqueueJob(tx, checked.actor, 'analytics.query', id);
        await tx.execute(
          sql`INSERT INTO analysis_requests(tenant_id,id,owner_id,actor_context,query_plan,plan_hash,scope_snapshot,authz_version,job_id,origin_run_id,state) VALUES(${actor.tenant_id},${id},${actor.user_id},${json(checked.actor)},${json(checked.plan)},${hashPayload(checked.plan)},${json(checked.scope)},${checked.actor.authz_version},${jobId},${context.origin_run_id ?? null},'queued')`,
        );
        return {
          request_id: id,
          job_id: jobId,
          origin_run_id: context.origin_run_id ?? null,
          status: 'queued' as const,
          snapshot_id: null,
          poll_after_ms: 1000,
        };
      },
    );
  }
  async function executeQuery(job: Row) {
    await database.transaction(
      async (tx) => {
        await assertJob(tx, job);
        const request = (
          await tx.execute(
            sql`SELECT * FROM analysis_requests WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string} FOR UPDATE`,
          )
        ).rows[0];
        if (!request) throw new AppError('NOT_FOUND', '分析请求不存在。');
        if (request.snapshot_id) {
          await finishJob(tx, job, 'succeeded');
          return;
        }
        const actor = await assertScope(
            request.actor_context as ActorContext,
            request.scope_snapshot as AnalyticsScope,
          ),
          plan = QueryPlanSchema.parse(request.query_plan),
          scope = request.scope_snapshot as AnalyticsScope;
        if (actor.authz_version !== request.authz_version)
          throw new AppError(
            'REVALIDATION_REQUIRED',
            '分析任务权限版本已变化。',
          );
        const source = await readSource(tx, actor, scope),
          facts: AnalysisFact[] = [],
          notes: string[] = [];
        for (const c of source.claims) {
          const common = {
            claim_ref: {
              type: 'expense_claim' as const,
              id: String(c.id),
              version: Number(c.version),
            },
            applicant_id: String(c.owner_id),
            department_id: String(c.department_id),
            submitted_at: asTime(c.submitted_at),
            completed_at: asTime(c.completed_at),
            state: String(c.state),
          };
          facts.push({
            id: `claim:${c.id}`,
            fact_kind: 'claim',
            line_id: null,
            line_version: null,
            expense_type: null,
            amount_minor: String(c.total_minor),
            entertainment_valid: null,
            ...common,
          });
          const claimLines = source.lines.filter((l) => l.claim_id === c.id),
            sum = claimLines.reduce(
              (v, l) => v + BigInt(String(l.amount_minor)),
              0n,
            );
          if (sum !== BigInt(String(c.total_minor)))
            notes.push(`单据 ${c.id} 的费用行合计与总额不一致。`);
          for (const l of claimLines) {
            const data = l.data as Record<string, unknown>;
            facts.push({
              id: `line:${c.id}:${l.id}`,
              fact_kind: 'line',
              line_id: String(l.id),
              line_version: Number(l.version),
              expense_type: String(l.expense_type),
              amount_minor: String(l.amount_minor),
              entertainment_valid: data.oa_ref
                ? l.oa_state === 'approved'
                : null,
              ...common,
            });
          }
        }
        let eligibility: {
          eligible_ids: string[];
          checked_count: number;
          unchecked_count: number;
        } | null = null;
        if (plan.metric.includes('pending_') || plan.metric.includes('low_')) {
          const tasks = (
            await tx.execute(
              sql`SELECT resource_id FROM approval_tasks WHERE tenant_id=${actor.tenant_id} AND assigned_to=${actor.user_id} AND state='pending' AND node='manager' AND resource_type='expense_claim'`,
            )
          ).rows;
          const assigned = new Set(tasks.map((t) => String(t.resource_id)));
          for (const f of facts)
            if (!assigned.has(f.claim_ref.id)) f.state = 'unassigned';
        }
        if (plan.metric.includes('low_')) {
          if (!options.lowCandidates)
            throw new AppError(
              'INVALID_STATE',
              '低风险资格服务尚未接入，不能推断候选数。',
            );
          eligibility = await options.lowCandidates(
            actor,
            facts
              .filter(
                (f) => f.fact_kind === 'claim' && f.state === 'pending_manager',
              )
              .map((f) => ({
                id: f.claim_ref.id,
                version: f.claim_ref.version,
              })),
            tx,
          );
        }
        const result = aggregate(
            facts,
            plan,
            new Set(eligibility?.eligible_ids ?? []),
          ),
          base =
            'from' in plan.period && plan.period.compare_to
              ? aggregate(facts, plan, new Set(), true)
              : null;
        const id = randomUUID(),
          time = new Date().toISOString(),
          definition = METRIC_CATALOG.find((m) => m.metric_id === plan.metric)!,
          quality = !result.used.length
            ? 'empty'
            : notes.length
              ? 'degraded'
              : 'ready';
        const body: SnapshotBody = {
          id,
          version: 1,
          metric: plan.metric,
          total:
            definition.unit === 'count'
              ? { count: Number(result.total) }
              : money(result.total),
          comparison: base
            ? {
                base: money(base.total),
                delta: money(result.total - base.total),
                ...percentageChange(result.total, base.total),
              }
            : null,
          rows: result.rows,
          chart: {
            spec_version: 1,
            type: 'bar',
            snapshot_id: id,
            unit: definition.unit,
            rows: result.rows,
          },
          quality,
          quality_notes: notes,
          snapshot_at: time,
          plan_hash: hashPayload(plan),
          source_watermark: source.watermark,
          scope_label: scope.department_ids.join('、') || '本人',
          period_label:
            'from' in plan.period
              ? `${plan.period.from} 至 ${plan.period.to_exclusive}（不含结束日）${plan.period.compare_to ? `；对比 ${plan.period.compare_to.from} 至 ${plan.period.compare_to.to_exclusive}（不含结束日）` : ''}`
              : '当前时点存量',
          evidence_refs: result.used.map((f) => `${id}:${f.id}`),
          checked_count: eligibility?.checked_count ?? null,
          unchecked_count: eligibility?.unchecked_count ?? null,
        };
        await tx.execute(
          sql`INSERT INTO analysis_snapshots(tenant_id,id,request_id,owner_id,query_plan,scope_snapshot,scope_hash,snapshot_at,business_date,source_watermark,catalog_version,quality,body) VALUES(${actor.tenant_id},${id},${request.id as string},${actor.user_id},${json(plan)},${json(scope)},${hashPayload(scope)},${new Date(time)},${(await options.businessDate?.()) ?? localDate(time)},${source.watermark},${catalogVersion},${quality},${json(body)})`,
        );
        for (const fact of facts)
          await tx.execute(
            sql`INSERT INTO analysis_facts(tenant_id,snapshot_id,id,fact_kind,source_id,claim_id,body) VALUES(${actor.tenant_id},${id},${fact.id},${fact.fact_kind},${fact.fact_kind === 'claim' ? fact.claim_ref.id : `${fact.claim_ref.id}:${fact.line_id}`},${fact.claim_ref.id},${json(fact)})`,
          );
        await tx.execute(
          sql`UPDATE analysis_requests SET state=${quality},snapshot_id=${id},version=version+1,updated_at=now() WHERE tenant_id=${actor.tenant_id} AND id=${request.id as string}`,
        );
        await finishJob(tx, job, 'succeeded');
      },
      { isolationLevel: 'repeatable read' },
    );
  }
  async function snapshotRecord(
    actor: ActorContext,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const a = await fresh(actor),
      row = (
        await tx.execute(
          sql`SELECT * FROM analysis_snapshots WHERE tenant_id=${a.tenant_id} AND owner_id=${a.user_id} AND id=${id}`,
        )
      ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '分析快照不存在或无权访问。');
    await assertScope(a, row.scope_snapshot as AnalyticsScope);
    return row;
  }
  async function getSnapshot(actor: ActorContext, id: string) {
    const row = await snapshotRecord(actor, id),
      source = await readSource(
        database,
        actor,
        row.scope_snapshot as AnalyticsScope,
      );
    return {
      ...(row.body as SnapshotBody),
      freshness: (source.watermark === row.source_watermark &&
      row.catalog_version === catalogVersion
        ? 'fresh'
        : 'stale') as 'fresh' | 'stale',
      query_plan: row.query_plan as QueryPlan,
    };
  }
  async function getQuery(actor: ActorContext, id: string) {
    const a = await fresh(actor),
      row = (
        await database.execute(
          sql`SELECT * FROM analysis_requests WHERE tenant_id=${a.tenant_id} AND owner_id=${a.user_id} AND id=${id}`,
        )
      ).rows[0];
    if (!row) throw new AppError('NOT_FOUND', '分析请求不存在。');
    await assertScope(a, row.scope_snapshot as AnalyticsScope);
    return {
      id,
      status: String(row.state),
      snapshot_id: row.snapshot_id as string | null,
      job_id: String(row.job_id),
      origin_run_id: row.origin_run_id as string | null,
      error_code: row.error_code as string | null,
      version: Number(row.version),
    };
  }
  async function drillSnapshot(
    actor: ActorContext,
    id: string,
    input: unknown,
  ) {
    const q = z
        .strictObject({
          dimension_key: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(input),
      row = await snapshotRecord(actor, id),
      body = row.body as SnapshotBody,
      plan = QueryPlanSchema.parse(row.query_plan);
    const group = q.dimension_key
      ? body.rows.find((g) => g.dimension_key === q.dimension_key)
      : null;
    if (q.dimension_key && !group)
      throw new AppError('NOT_FOUND', '快照分组不存在。');
    const records = (
      await database.execute(
        sql`SELECT body FROM analysis_facts WHERE tenant_id=${actor.tenant_id} AND snapshot_id=${id} ORDER BY id`,
      )
    ).rows.map((r) => r.body as AnalysisFact);
    const definition = METRIC_CATALOG.find((m) => m.metric_id === plan.metric)!;
    const selectedIds = new Set(
      group?.fact_refs ?? body.evidence_refs.map((r) => r.slice(id.length + 1)),
    );
    const all = records.filter(
      (f) =>
        f.fact_kind === definition.grain &&
        selectedIds.has(f.id) &&
        (!q.cursor || f.id > q.cursor),
    );
    const items = all.slice(0, q.limit);
    return {
      items,
      next_cursor: all.length > q.limit ? items.at(-1)!.id : null,
      snapshot_id: id,
    };
  }
  async function reportRecord(
    actor: ActorContext,
    id: string,
    tx: DatabaseExecutor = database,
  ) {
    const a = await fresh(actor),
      r = (
        await tx.execute(
          sql`SELECT * FROM analysis_reports WHERE tenant_id=${a.tenant_id} AND owner_id=${a.user_id} AND id=${id}`,
        )
      ).rows[0];
    if (!r) throw new AppError('NOT_FOUND', '报告不存在。');
    await snapshotRecord(a, String(r.analysis_snapshot_id), tx);
    return r;
  }
  async function createReport(
    actor: ActorContext,
    input: unknown,
    key: string,
    context: { origin_run_id?: string | null } = {},
  ) {
    const a = await fresh(actor),
      d = z
        .strictObject({
          analysis_snapshot_id: z.string().min(1),
          template: ReportTemplateSchema,
        })
        .parse(input),
      snapshot = await getSnapshot(a, d.analysis_snapshot_id);
    return writeCommand(database, a, 'analytics.report', key, d, async (tx) => {
      const id = randomUUID(),
        jobId = await enqueueJob(tx, a, 'analytics.report', id),
        blocks = {
          title: d.template === 'monthly_expense' ? '费用月报' : '今日费用报告',
          narrative: '统计金额、口径与范围以冻结事实块为准。',
          recommendations: '',
          user_note: '',
        };
      await tx.execute(
        sql`INSERT INTO analysis_reports(tenant_id,id,owner_id,analysis_snapshot_id,template_id,state,job_id) VALUES(${a.tenant_id},${id},${a.user_id},${d.analysis_snapshot_id},${d.template},'draft',${jobId})`,
      );
      await tx.execute(
        sql`INSERT INTO analysis_report_versions(tenant_id,report_id,version_no,editable_blocks,locked_fact_hash,created_by) VALUES(${a.tenant_id},${id},1,${json(blocks)},${hashPayload({ total: snapshot.total, rows: snapshot.rows, comparison: snapshot.comparison })},${a.user_id})`,
      );
      return {
        report_id: id,
        status: 'queued',
        job_id: jobId,
        origin_run_id: context.origin_run_id ?? null,
        poll_after_ms: 1000,
      };
    });
  }
  async function getReport(actor: ActorContext, id: string) {
    const r = await reportRecord(actor, id),
      v = (
        await database.execute(
          sql`SELECT * FROM analysis_report_versions WHERE tenant_id=${actor.tenant_id} AND report_id=${id} AND version_no=${Number(r.current_draft_version)}`,
        )
      ).rows[0]!;
    return {
      id: String(r.id),
      tenant_id: String(r.tenant_id),
      owner_id: String(r.owner_id),
      analysis_snapshot_id: String(r.analysis_snapshot_id),
      template_id: String(r.template_id),
      template_version: String(r.template_version),
      state: r.state as 'draft' | 'ready' | 'archived',
      version: Number(r.version),
      current_draft_version: Number(r.current_draft_version),
      job_id: r.job_id as string | null,
      created_at: new Date(r.created_at as string).toISOString(),
      updated_at: new Date(r.updated_at as string).toISOString(),
      editable_blocks: v.editable_blocks as z.infer<
        typeof EditableBlocksSchema
      >,
      locked_fact_hash: String(v.locked_fact_hash),
      snapshot: await getSnapshot(actor, String(r.analysis_snapshot_id)),
    };
  }
  async function patchReport(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const a = await fresh(actor),
      d = z
        .strictObject({
          expected_version: z.number().int().positive(),
          editable_blocks: EditableBlocksSchema,
        })
        .parse(input);
    if (
      [d.editable_blocks.narrative, d.editable_blocks.recommendations].some(
        (v) => v && /\d[\d,.]*\s*(?:元|万元|%|％)/.test(v),
      )
    )
      throw new AppError(
        'VALIDATION_ERROR',
        '统计金额与比例请引用事实块；补充数字请放入用户补充。',
      );
    return writeCommand(
      database,
      a,
      'analytics.report.patch',
      key,
      { id, ...d },
      async (tx) => {
        await tx.execute(
          sql`SELECT id FROM analysis_reports WHERE tenant_id=${a.tenant_id} AND id=${id} FOR UPDATE`,
        );
        const r = await reportRecord(a, id, tx);
        if (r.version !== d.expected_version)
          throw new AppError('VERSION_CONFLICT', '报告版本已变化。');
        const prior = (
          await tx.execute(
            sql`SELECT * FROM analysis_report_versions WHERE tenant_id=${a.tenant_id} AND report_id=${id} AND version_no=${Number(r.current_draft_version)}`,
          )
        ).rows[0]!;
        const next = Number(r.current_draft_version) + 1;
        await tx.execute(
          sql`INSERT INTO analysis_report_versions(tenant_id,report_id,version_no,editable_blocks,locked_fact_hash,created_by) VALUES(${a.tenant_id},${id},${next},${json({ ...(prior.editable_blocks as object), ...d.editable_blocks })},${prior.locked_fact_hash as string},${a.user_id})`,
        );
        await tx.execute(
          sql`UPDATE analysis_reports SET current_draft_version=${next},version=version+1,updated_at=now() WHERE tenant_id=${a.tenant_id} AND id=${id}`,
        );
        return {
          id,
          version: d.expected_version + 1,
          current_draft_version: next,
        };
      },
    );
  }
  async function exportReport(
    actor: ActorContext,
    id: string,
    input: unknown,
    key: string,
  ) {
    const a = await fresh(actor);
    if (!a.permissions.includes('analytics.export'))
      throw new AppError('FORBIDDEN', '无报告导出权限。');
    const d = ExportCommandSchema.parse(input),
      r = await reportRecord(a, id),
      snapshot = await getSnapshot(a, String(r.analysis_snapshot_id));
    if (r.version !== d.expected_version)
      throw new AppError('VERSION_CONFLICT', '报告版本已变化。');
    if (snapshot.freshness === 'stale' && d.freshness_choice === 'refresh')
      throw new AppError(
        'REVALIDATION_REQUIRED',
        '请先重新查询最新快照并生成报告。',
      );
    return writeCommand(
      database,
      a,
      'analytics.export',
      key,
      { id, ...d },
      async (tx) => {
        const existing = (
          await tx.execute(
            sql`SELECT id,job_id,state FROM analysis_artifacts WHERE tenant_id=${a.tenant_id} AND owner_id=${a.user_id} AND report_id=${id} AND report_version=${Number(r.current_draft_version)} AND snapshot_id=${String(r.analysis_snapshot_id)} AND format=${d.format}`,
          )
        ).rows[0];
        if (existing)
          return {
            artifact_id: String(existing.id),
            job_id: String(existing.job_id),
            status: String(existing.state),
          };
        const artifactId = randomUUID(),
          jobId = await enqueueJob(tx, a, 'analytics.export', artifactId);
        await tx.execute(
          sql`INSERT INTO analysis_artifacts(tenant_id,id,owner_id,report_id,report_version,snapshot_id,format,state,object_key,expires_at,export_scope_hash,freshness_choice,job_id,actor_context) VALUES(${a.tenant_id},${artifactId},${a.user_id},${id},${Number(r.current_draft_version)},${String(r.analysis_snapshot_id)},${d.format},'queued',${`private/report-artifacts/${a.tenant_id}/${artifactId}.${d.format}`},now()+interval '24 hours',${hashPayload(snapshot.query_plan.filters)},${d.freshness_choice},${jobId},${json(a)})`,
        );
        return { artifact_id: artifactId, job_id: jobId, status: 'queued' };
      },
    );
  }
  async function renderExport(job: Row) {
    if (!options.storage)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '私有导出存储尚未配置。');
    const artifact = (
      await database.execute(
        sql`SELECT * FROM analysis_artifacts WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
      )
    ).rows[0];
    if (!artifact) throw new AppError('NOT_FOUND', '导出任务不存在。');
    const actor = await fresh(artifact.actor_context as ActorContext);
    if (!actor.permissions.includes('analytics.export'))
      throw new AppError('FORBIDDEN', '导出授权已失效。');
    const report = await reportRecord(actor, String(artifact.report_id)),
      snapshot = await getSnapshot(actor, String(artifact.snapshot_id));
    const version = (
      await database.execute(
        sql`SELECT * FROM analysis_report_versions WHERE tenant_id=${actor.tenant_id} AND report_id=${artifact.report_id as string} AND version_no=${Number(artifact.report_version)}`,
      )
    ).rows[0]!;
    const facts = (
        await database.execute(
          sql`SELECT body FROM analysis_facts WHERE tenant_id=${actor.tenant_id} AND snapshot_id=${artifact.snapshot_id as string} ORDER BY id`,
        )
      ).rows.map((r) => r.body as AnalysisFact),
      used = new Set(
        snapshot.evidence_refs.map((v) => v.slice(snapshot.id.length + 1)),
      ),
      rows = facts.filter((f) => used.has(f.id));
    const blocks = version.editable_blocks as Record<string, string>,
      historical =
        snapshot.freshness === 'stale'
          ? '历史快照，源数据已更新。'
          : '冻结分析快照。';
    const csv =
      '\uFEFF' +
      [
        'record_kind,snapshot_id,claim_id,applicant_id,department_id,amount_minor,currency,date_basis,snapshot_at,freshness,quality,notes',
        [
          'metadata',
          csvText(snapshot.id),
          '',
          '',
          '',
          '',
          'CNY',
          csvText(snapshot.query_plan.period.date_basis),
          csvText(snapshot.snapshot_at),
          snapshot.freshness,
          snapshot.quality,
          csvText(`${historical} ${snapshot.quality_notes.join('；')}`),
        ].join(','),
        ...rows.map((f) =>
          [
            'fact',
            csvText(snapshot.id),
            csvText(f.claim_ref.id),
            csvText(f.applicant_id),
            csvText(f.department_id),
            f.amount_minor,
            'CNY',
            csvText(snapshot.query_plan.period.date_basis),
            csvText(snapshot.snapshot_at),
            snapshot.freshness,
            snapshot.quality,
            '',
          ].join(','),
        ),
      ].join('\r\n');
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(blocks.title)}</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:24px}td,th{border:1px solid #aaa;padding:8px}table{border-collapse:collapse}</style></head><body><h1>${escapeHtml(blocks.title)}</h1><p>${escapeHtml(historical)} 截至 ${escapeHtml(snapshot.snapshot_at)}</p><p>${escapeHtml(snapshot.period_label)}；${escapeHtml(snapshot.scope_label)}；口径 ${escapeHtml(snapshot.query_plan.period.date_basis)}，审批完成不代表付款。</p><p>${escapeHtml(blocks.narrative)}</p><p>合计：${'amount_minor' in snapshot.total ? escapeHtml(snapshot.total.amount_minor) + ' 分 CNY' : escapeHtml(snapshot.total.count) + ' 张'}</p><table><thead><tr><th>分组</th><th>值（分或张）</th></tr></thead><tbody>${snapshot.rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.value)}</td></tr>`).join('')}</tbody></table>${snapshot.quality_notes.length ? `<section><h2>数据质量说明</h2><ul>${snapshot.quality_notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>` : ''}<h2>行动建议</h2><p>${escapeHtml(blocks.recommendations)}</p><h2>用户补充（未经业务数据验证）</h2><p>${escapeHtml(blocks.user_note)}</p><p>快照 ${escapeHtml(snapshot.id)}；事实校验 ${escapeHtml(version.locked_fact_hash)}</p></body></html>`;
    const bytes = Buffer.from(artifact.format === 'csv' ? csv : html),
      hash = createHash('sha256').update(bytes).digest('hex'),
      fileId = randomUUID();
    await options.storage.putObject({
      key: String(artifact.object_key),
      body: bytes,
      contentType:
        artifact.format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'text/html; charset=utf-8',
    });
    const check = await options.storage.getObject(String(artifact.object_key));
    if (createHash('sha256').update(check.body).digest('hex') !== hash)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '导出文件校验失败。');
    await database.transaction(async (tx) => {
      await assertJob(tx, job);
      await snapshotRecord(actor, String(report.analysis_snapshot_id), tx);
      await tx.execute(
        sql`INSERT INTO uploaded_files(id,tenant_id,owner_id,status,object_key,original_filename,mime_type,expected_size_bytes,size_bytes,sha256,upload_expires_at) VALUES(${fileId},${actor.tenant_id},${actor.user_id},'validated',${String(artifact.object_key)},${`费用报告.${artifact.format}`},${artifact.format === 'csv' ? 'text/csv' : 'text/html'},${bytes.length},${bytes.length},${hash},now()+interval '24 hours') ON CONFLICT(object_key) DO NOTHING`,
      );
      await tx.execute(
        sql`UPDATE analysis_artifacts SET state='ready',file_id=(SELECT id FROM uploaded_files WHERE object_key=${String(artifact.object_key)}),sha256=${hash},size_bytes=${bytes.length},version=version+1,updated_at=now() WHERE tenant_id=${actor.tenant_id} AND id=${artifact.id as string}`,
      );
      await finishJob(tx, job, 'succeeded');
    });
  }
  async function getArtifact(actor: ActorContext, id: string) {
    const a = await fresh(actor),
      r = (
        await database.execute(
          sql`SELECT * FROM analysis_artifacts WHERE tenant_id=${a.tenant_id} AND owner_id=${a.user_id} AND id=${id}`,
        )
      ).rows[0];
    if (!r) throw new AppError('NOT_FOUND', '导出文件不存在。');
    await snapshotRecord(a, String(r.snapshot_id));
    if (!a.permissions.includes('analytics.export'))
      throw new AppError('FORBIDDEN', '导出权限已失效。');
    return {
      id,
      state: String(r.state),
      version: Number(r.version),
      job_id: String(r.job_id),
      format: String(r.format),
      size_bytes: r.size_bytes as number | null,
      sha256: r.sha256 as string | null,
      expires_at: new Date(r.expires_at as string).toISOString(),
      downloadable:
        r.state === 'ready' &&
        new Date(r.expires_at as string).getTime() > Date.now(),
    };
  }
  async function downloadArtifact(actor: ActorContext, id: string) {
    const view = await getArtifact(actor, id);
    if (!view.downloadable || !options.storage)
      throw new AppError('INVALID_STATE', '文件未完成、已过期或存储尚未配置。');
    const r = (
      await database.execute(
        sql`SELECT object_key FROM analysis_artifacts WHERE tenant_id=${actor.tenant_id} AND id=${id}`,
      )
    ).rows[0]!;
    const data = await options.storage.getObject(String(r.object_key));
    if (createHash('sha256').update(data.body).digest('hex') !== view.sha256)
      throw new AppError('DEPENDENCY_UNAVAILABLE', '文件完整性校验失败。');
    return {
      bytes: data.body,
      content_type:
        view.format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'text/html; charset=utf-8',
      filename: `费用报告.${view.format}`,
    };
  }
  async function processJob(id: string, workerId = 'insights-worker') {
    const job = await claimInsightJob(database, id, workerId);
    if (!job) return false;
    const stopHeartbeat = startJobHeartbeat(database, job);
    try {
      if (job.kind === 'analytics.query') await executeQuery(job);
      else if (job.kind === 'analytics.export') await renderExport(job);
      else if (job.kind === 'analytics.report')
        await database.transaction(async (tx) => {
          await assertJob(tx, job);
          const report = (
            await tx.execute(
              sql`SELECT * FROM analysis_reports WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
            )
          ).rows[0]!;
          const request = (
            await tx.execute(
              sql`SELECT r.actor_context FROM analysis_requests r JOIN analysis_snapshots s ON s.request_id=r.id AND s.tenant_id=r.tenant_id WHERE s.tenant_id=${job.tenant_id as string} AND s.id=${report.analysis_snapshot_id as string}`,
            )
          ).rows[0]!;
          await reportRecord(
            request.actor_context as ActorContext,
            String(report.id),
            tx,
          );
          await tx.execute(
            sql`UPDATE analysis_reports SET state='ready',version=version+1,updated_at=now() WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
          );
          await finishJob(tx, job, 'succeeded');
        });
      else throw new AppError('INVALID_STATE', '不是分析领域作业。');
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE';
      await database.transaction(async (tx) => {
        await assertJob(tx, job);
        if (job.kind === 'analytics.query')
          await tx.execute(
            sql`UPDATE analysis_requests SET state='failed',error_code=${code},updated_at=now() WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
          );
        if (job.kind === 'analytics.export')
          await tx.execute(
            sql`UPDATE analysis_artifacts SET state='failed',error_code=${code},updated_at=now() WHERE tenant_id=${job.tenant_id as string} AND id=${job.payload_ref as string}`,
          );
        await finishJob(tx, job, 'failed', code);
      });
    } finally {
      stopHeartbeat();
    }
    return true;
  }
  async function refreshSnapshot(
    actor: ActorContext,
    id: string,
    expectedVersion: number,
    key: string,
  ) {
    const snapshot = await getSnapshot(actor, id);
    if (snapshot.version !== expectedVersion)
      throw new AppError('VERSION_CONFLICT', '快照版本不匹配。');
    return query(actor, snapshot.query_plan, key);
  }
  return {
    query,
    validatePlan,
    getQuery,
    getSnapshot,
    drillSnapshot,
    createReport,
    getReport,
    patchReport,
    exportReport,
    getArtifact,
    downloadArtifact,
    processJob,
    refreshSnapshot,
    getCatalog: async (actor: ActorContext) => {
      await fresh(actor);
      return {
        catalog_version: catalogVersion,
        metrics: METRIC_CATALOG,
        dimensions: dims,
        templates: ReportTemplateSchema.options,
      };
    },
  };
}
export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
