import { AgentCardSchema, type AgentCard } from '@caixiaozhi/contracts/cards';
import {
  ResourceRefSchema,
  MoneySchema,
  type ResourceRef,
} from '@caixiaozhi/contracts/common';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import type { RunService } from '@caixiaozhi/agent-runtime';
import type { Run } from '@caixiaozhi/contracts/runs';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const refs = (value: unknown): ResourceRef[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const r = ResourceRefSchema.safeParse(item);
        return r.success ? [r.data] : [];
      })
    : [];
const money = (value: unknown) =>
  MoneySchema.safeParse(value).success ? MoneySchema.parse(value) : null;

/** 卡片只由领域工具真实DTO投影；模型文本不能直接生成业务卡片。 */
export function createCardProjector(
  database: DatabaseConnection,
  runs: RunService,
) {
  return async function publish(
    run: Run,
    epoch: number,
    tool: string,
    value: unknown,
    args: unknown = {},
  ) {
    if (!run.thread_id || !run.input_message_id) return;
    const data = record(value),
      input = record(args),
      now = new Date().toISOString();
    let type: AgentCard['type'] | null = null,
      title = '',
      summary = '',
      payload: Record<string, unknown> = {},
      resourceRefs: ResourceRef[] = [],
      subject = '';
    if (tool === 'finance.todo.list') {
      const items = Array.isArray(data.items) ? data.items : [];
      resourceRefs = items.flatMap((item) =>
        refs([record(record(item).document).resource_ref]),
      );
      type = 'todo_summary';
      title = '当前授权待办';
      summary = data.next_cursor
        ? '当前页待办，可继续读取后续页。'
        : '已读取当前指派给你的待办。';
      payload = {
        count: items.length,
        total: money(data.page_total) ?? { amount_minor: '0', currency: 'CNY' },
        list_scope: '当前授权待办（本页）',
        source_as_of: now,
      };
    } else if (tool === 'finance.document.get') {
      resourceRefs = refs([data.resource_ref]);
      if (!resourceRefs.length) return;
      subject = resourceRefs[0]!.id;
      type = 'document_summary';
      title = String(data.title);
      summary = `当前状态：${String(data.state)}`;
      payload = {
        document_ref: resourceRefs[0],
        status: String(data.state),
        total: money(data.total_amount ?? data.total_budget ?? data.budget),
        missing_fields: [],
      };
    } else if (tool === 'finance.preaudit.get') {
      const task = record(data.task),
        groups = record(record(data.summary).groups),
        items = Array.isArray(data.items) ? data.items : [];
      if (typeof task.id !== 'string') return;
      subject = task.id;
      type = 'preaudit_summary';
      title = '当前预审结果';
      summary = '预审提供风险与覆盖证据，批准仍需本人确认。';
      resourceRefs = items.flatMap((item) => refs([record(item).document_ref]));
      payload = {
        preaudit_task_id: task.id,
        counts: Object.fromEntries(
          ['risk', 'incomplete', 'attention', 'low'].map((key) => [
            key,
            Number(record(groups[key]).count ?? 0),
          ]),
        ),
        totals: {
          all: money(record(data.summary).total_amount) ?? {
            amount_minor: '0',
            currency: 'CNY',
          },
          low: money(record(groups.low).amount) ?? {
            amount_minor: '0',
            currency: 'CNY',
          },
        },
        progress: {
          completed:
            Number(record(data.counts).completed ?? 0) +
            Number(record(data.counts).failed ?? 0) +
            Number(record(data.counts).stale ?? 0),
          total: Number(task.total),
        },
        reviewer_id: run.owner_id,
      };
    } else if (tool === 'finance.rules.propose') {
      if (typeof data.id !== 'string') return;
      subject = data.id;
      type = 'rule_proposal';
      title = '规则候选';
      summary = String(
        data.name ?? '请查看结构化范围与比较边界，测试后再确认启用。',
      );
      resourceRefs = refs([
        { type: 'rule', id: data.id, version: data.version },
      ]);
      payload = {
        proposal_id: data.id,
        rule_ref: resourceRefs[0] ?? null,
        test_summary: null,
      };
    } else if (tool === 'finance.knowledge.search') {
      const hits = Array.isArray(data.hits) ? data.hits : [];
      subject = String(data.retrieval_snapshot_id ?? '');
      type = 'policy_answer';
      title = '制度来源';
      summary = hits.length
        ? '已检索授权来源，以下为原文摘录。'
        : '未找到足够适用来源，请补充查询条件。';
      resourceRefs = hits.flatMap((hit) => refs([record(hit).policy_ref]));
      payload = {
        answer: hits.map((hit) => String(record(hit).quote ?? '')).join('\n\n'),
        citation_refs: hits.map((hit) => String(record(hit).citation_id)),
        effective_at: new Date(
          `${String(data.business_date)}T00:00:00+08:00`,
        ).toISOString(),
        unresolved_questions: Array.isArray(data.conflicts)
          ? data.conflicts.map((item) => String(record(item).message))
          : [],
      };
    } else if (tool === 'finance.analytics.snapshot') {
      if (typeof data.id !== 'string') return;
      subject = data.id;
      type = 'analysis_result';
      title = '费用分析快照';
      summary = String(data.period_label ?? '请核对指标、范围与时间口径。');
      resourceRefs = refs([
        { type: 'analysis', id: data.id, version: data.version ?? 1 },
      ]);
      payload = {
        analysis_ref: resourceRefs[0],
        metric_id: String(data.metric),
        filter_summary: String(data.scope_label),
        coverage: data.quality === 'degraded' ? 'partial' : 'complete',
      };
    } else if (tool === 'finance.report.result') {
      if (typeof data.id !== 'string') return;
      subject = data.id;
      type = 'report_result';
      title = '报告草稿';
      summary = '统计事实块冻结，文字说明可编辑。';
      resourceRefs = refs([
        { type: 'report', id: data.id, version: data.version ?? 1 },
      ]);
      payload = {
        report_ref: resourceRefs[0],
        generation_status:
          data.state === 'ready'
            ? 'completed'
            : ['failed', 'queued', 'running'].includes(String(data.state))
              ? data.state
              : 'completed',
        download_action: null,
      };
    } else if (tool === 'finance.action.status') {
      if (typeof data.id !== 'string') return;
      subject = data.id;
      type = 'action_result';
      title = '原动作回执';
      summary = '每项状态以原业务回执为准。';
      resourceRefs = refs(data.resource_refs);
      const items = Array.isArray(data.items) ? data.items : [];
      payload = {
        action_ids: [data.id],
        receipt_ids: items.flatMap((item) =>
          typeof record(record(item).receipt).id === 'string'
            ? [record(record(item).receipt).id]
            : [],
        ),
        outcomes: items.flatMap((item) => {
          const receipt = record(record(item).receipt);
          return typeof receipt.outcome === 'string'
            ? [
                {
                  action_id: data.id,
                  outcome: receipt.outcome,
                  error_code: receipt.error_code ?? null,
                },
              ]
            : [];
        }),
        affected_refs: resourceRefs,
      };
    } else if (
      tool === 'finance.travel.result' ||
      tool === 'finance.expense.result'
    ) {
      if (typeof data.id !== 'string') return;
      subject = data.id;
      type = 'draft_proposal';
      title = '单据差异建议';
      summary = '勾选采纳前，请比较最新草稿版本。';
      resourceRefs = refs([input.resource_ref]);
      payload = {
        proposal_id: data.id,
        base_ref: resourceRefs[0] ?? null,
        changes: Array.isArray(data.operations)
          ? data.operations.map((operation) => {
              const op = record(operation);
              const scalar = (v: unknown) =>
                v === null || ['string', 'number', 'boolean'].includes(typeof v)
                  ? v
                  : JSON.stringify(v);
              return {
                field: String(op.field ?? op.kind),
                before: scalar(op.old ?? null),
                after: scalar(op.new ?? op.leg ?? null),
              };
            })
          : [],
        validation_summary: String(data.status),
      };
    }
    if (!type) return;
    const id = `card-${canonicalHash({ run: run.id, tool, subject }).slice(0, 32)}`;
    const existing = await database.pool.query(
      'SELECT card,revision FROM cards WHERE tenant_id=$1 AND owner_id=$2 AND id=$3',
      [run.tenant_id, run.owner_id, id],
    );
    if (
      existing.rows[0] &&
      canonicalHash(existing.rows[0].card.payload) === canonicalHash(payload)
    )
      return;
    const card = AgentCardSchema.parse({
      id,
      schema_version: 1,
      type,
      thread_id: run.thread_id,
      message_id: run.input_message_id,
      run_id: run.id,
      title,
      summary,
      snapshot_at: now,
      resource_refs: resourceRefs,
      payload,
      actions: resourceRefs.map((ref) => ({
        id: `open:${ref.type}:${ref.id}`,
        label: '查看详情',
        kind: 'open_drawer',
        target: ref.id,
      })),
      revision: Number(existing.rows[0]?.revision ?? 0) + 1,
      stale: false,
    });
    await runs.appendEvent(run.id, epoch, 'card.upsert', card);
  };
}
