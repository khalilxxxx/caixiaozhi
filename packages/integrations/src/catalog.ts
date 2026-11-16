import type { CapabilityDefinition } from '@caixiaozhi/contracts/integrations';
import { z } from 'zod';
import { StartPreauditSchema } from '@caixiaozhi/contracts/preaudit';
import { KnowledgeSearchSchema } from '@caixiaozhi/contracts/knowledge';
import { QueryPlanSchema } from '@caixiaozhi/contracts/analytics';
import {
  RuleProposalSchema,
  RuleTestToolInputSchema,
  RuleTestTaskAcceptedSchema,
  RuleTestProofSchema,
} from '@caixiaozhi/contracts/rules';
import { TravelProposalInputSchema } from '@caixiaozhi/contracts/travel';
import { MoneySchema, ResourceRefSchema } from '@caixiaozhi/contracts/common';
import { ActionViewSchema } from '@caixiaozhi/contracts/actions';
import { PreauditTaskAcceptedSchema } from '@caixiaozhi/contracts/preaudit';
import { PolicyCitationSchema } from '@caixiaozhi/contracts/knowledge';
import { ExpenseProposalInputSchema } from '@caixiaozhi/contracts/expenses';
const str = { type: 'string', minLength: 1 },
  version = { type: 'integer', minimum: 1 };
const resource = {
  type: 'object',
  properties: {
    type: {
      enum: [
        'travel',
        'expense_claim',
        'oa_request',
        'rule',
        'skill',
        'policy',
        'analysis',
        'report',
      ],
    },
    id: str,
    version,
  },
  required: ['type', 'id', 'version'],
  additionalProperties: false,
};
const array = (items: unknown) => ({ type: 'array', items, maxItems: 50 });
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const specs: Array<
  [
    string,
    'read' | 'propose',
    string,
    Record<string, unknown>,
    string[],
    string[],
  ]
> = [
  [
    'finance.todo.list',
    'read',
    '读取当前授权范围内待办',
    {
      object_types: array({ enum: ['travel', 'expense_claim', 'oa_request'] }),
      cursor: str,
    },
    [],
    [],
  ],
  [
    'finance.document.get',
    'read',
    '读取当前授权单据与精确版本',
    { type: { enum: ['travel', 'expense_claim', 'oa_request'] }, id: str },
    ['type', 'id'],
    [],
  ],
  [
    'finance.preaudit.start',
    'read',
    '创建只读业务预审任务并返回真实任务标识',
    {
      purpose: { enum: ['manager_review', 'finance_review', 'self_check'] },
      documents: array(resource),
    },
    ['purpose', 'documents'],
    [],
  ],
  [
    'finance.preaudit.get',
    'read',
    '读取本人授权预审进度和证据',
    { task_id: str },
    ['task_id'],
    [],
  ],
  [
    'finance.rules.propose',
    'propose',
    '保存结构化规则候选，发布另需本人确认',
    {
      natural_language: str,
      module: str,
      purpose: str,
      current_rule_ref: resource,
      source_refs: array(resource),
    },
    ['natural_language', 'module', 'purpose'],
    [],
  ],
  [
    'finance.rules.test',
    'read',
    '使用授权的固定测试集验证规则草稿',
    { rule_id: str, draft_version: version, test_set_id: str },
    ['rule_id', 'draft_version', 'test_set_id'],
    [],
  ],
  [
    'finance.knowledge.search',
    'read',
    '搜索已授权且适用的制度来源',
    {
      query: str,
      business_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      scenario: str,
      department_id: str,
    },
    ['query', 'business_date'],
    [],
  ],
  [
    'finance.analytics.query',
    'read',
    '按固定口径创建授权分析快照',
    {
      metric: str,
      period: { type: 'object' },
      dimensions: array(str),
      filters: { type: 'object' },
    },
    ['metric', 'period'],
    ['analytics.query'],
  ],
  [
    'finance.report.create',
    'propose',
    '基于已有分析快照创建私有报告草稿',
    { analysis_snapshot_id: str, template: str },
    ['analysis_snapshot_id', 'template'],
    ['analytics.query'],
  ],
  [
    'finance.travel.propose_patch',
    'propose',
    '从最新差旅草稿生成差异建议，不直接提交',
    {
      id: str,
      expected_version: version,
      prompt: str,
      selected_material_refs: array(resource),
      focus_leg_id: str,
    },
    ['id', 'expected_version', 'prompt', 'selected_material_refs'],
    [],
  ],
  [
    'finance.expense.propose_patch',
    'propose',
    '从最新报销草稿与授权发票生成差异建议',
    {
      id: str,
      expected_version: version,
      prompt: str,
      selected_material_refs: array(resource),
      invoice_refs: array(object({ id: str, version }, ['id', 'version'])),
    },
    [
      'id',
      'expected_version',
      'prompt',
      'selected_material_refs',
      'invoice_refs',
    ],
    [],
  ],
  [
    'finance.action.prepare',
    'propose',
    '准备需本人浏览器确认的写入意图，不返回确认令牌',
    { action: str, resource_refs: array(resource), args: { type: 'object' } },
    ['action', 'resource_refs', 'args'],
    [],
  ],
  [
    'finance.action.status',
    'read',
    '读取本人动作的逐项回执，未知结果仅核实',
    { action_id: str },
    ['action_id'],
    [],
  ],
];
const sharedSchemas: Record<string, z.ZodType> = {
  'finance.preaudit.start': StartPreauditSchema,
  'finance.knowledge.search': KnowledgeSearchSchema,
  'finance.analytics.query': QueryPlanSchema,
  'finance.rules.propose': RuleProposalSchema,
  'finance.rules.test': RuleTestToolInputSchema,
  'finance.travel.propose_patch': TravelProposalInputSchema.extend({
    id: z.string().min(1),
  }),
  'finance.expense.propose_patch': ExpenseProposalInputSchema.safeExtend({
    id: z.string().min(1),
  }),
};
const identifier = z.string().min(1),
  positive = z.number().int().positive(),
  nullableId = identifier.nullable();
const domainDocument = z
  .object({
    id: identifier,
    tenant_id: identifier,
    owner_id: identifier,
    department_id: identifier,
    version: positive,
    state: identifier,
    title: z.string(),
    resource_ref: ResourceRefSchema,
  })
  .passthrough();
const acceptedGeneration = z
  .object({
    task_id: identifier,
    job_id: identifier,
    status: z.enum(['queued', 'running']),
  })
  .passthrough();
const proposalAccepted = z
  .object({
    task_id: identifier,
    proposal_id: identifier,
    job_id: identifier,
    status: z.enum(['queued', 'running']),
    base_version: positive,
  })
  .passthrough();
const outputSchemas: Record<string, z.ZodType> = {
  'finance.todo.list': z
    .object({
      items: z.array(
        z
          .object({
            task_ref: z.strictObject({ id: identifier, version: positive }),
            node: z.enum(['manager', 'finance']),
            document: domainDocument,
          })
          .passthrough(),
      ),
      next_cursor: nullableId,
      count: z.number().int().nonnegative(),
      page_total: MoneySchema,
    })
    .passthrough(),
  'finance.document.get': domainDocument,
  'finance.preaudit.start': PreauditTaskAcceptedSchema,
  'finance.preaudit.get': z
    .object({
      task: z
        .object({
          id: identifier,
          version: positive,
          status: z.enum([
            'queued',
            'running',
            'completed',
            'partial_failed',
            'failed',
            'cancelled',
          ]),
        })
        .passthrough(),
      items: z.array(
        z
          .object({
            id: identifier,
            document_ref: ResourceRefSchema,
            status: z.enum([
              'pending',
              'running',
              'completed',
              'failed',
              'stale',
            ]),
          })
          .passthrough(),
      ),
      summary: z.object({ total_amount: MoneySchema }).passthrough(),
    })
    .passthrough(),
  'finance.rules.propose': z.union([
    z
      .object({
        id: identifier,
        version: positive,
        level: z.enum(['personal', 'company']),
        lifecycle: identifier,
        versions: z.array(
          z.object({ id: identifier, version_number: positive }).passthrough(),
        ),
      })
      .passthrough(),
    acceptedGeneration,
  ]),
  'finance.rules.test': z.union([
    RuleTestTaskAcceptedSchema,
    RuleTestProofSchema,
  ]),
  'finance.knowledge.search': z
    .object({
      retrieval_snapshot_id: identifier,
      business_date: z.iso.date(),
      hits: z.array(PolicyCitationSchema),
      conflicts: z.array(
        z.strictObject({
          topic_key: identifier,
          citation_ids: z.array(identifier),
          message: z.string(),
        }),
      ),
      corpus_revision: positive,
    })
    .passthrough(),
  'finance.analytics.query': z
    .object({
      request_id: identifier,
      job_id: identifier,
      status: z.enum(['queued', 'running']),
      snapshot_id: nullableId,
      origin_run_id: nullableId,
      poll_after_ms: positive,
    })
    .passthrough(),
  'finance.report.create': z
    .object({
      report_id: identifier,
      job_id: identifier,
      status: z.enum(['queued', 'running']),
      origin_run_id: nullableId,
      poll_after_ms: positive,
    })
    .passthrough(),
  'finance.travel.propose_patch': proposalAccepted,
  'finance.expense.propose_patch': proposalAccepted,
  'finance.action.prepare': z.strictObject({
    action_id: identifier,
    confirmation_id: identifier,
    version: positive,
    summary: z.unknown(),
    summary_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.iso.datetime(),
    state: identifier,
  }),
  'finance.action.status': ActionViewSchema,
};
export const BUILTIN_CAPABILITIES: CapabilityDefinition[] = specs.map(
  ([name, effect, description, properties, required, permissions]) => ({
    id: `${name}@${name === 'finance.action.status' ? '1.1.0' : '1.0.0'}`,
    name,
    version: name === 'finance.action.status' ? '1.1.0' : '1.0.0',
    title: description,
    description,
    input_schema: sharedSchemas[name]
      ? z.toJSONSchema(sharedSchemas[name]!, {
          target: 'draft-2020-12',
          io: 'input',
        })
      : object(properties, required),
    output_schema: z.toJSONSchema(outputSchemas[name]!, {
      target: 'draft-2020-12',
      io: 'output',
    }),
    effect,
    required_permissions: permissions,
    connector_id: 'demo-business',
    timeout_ms: 10000,
    supports_idempotency: true,
    supports_receipt_lookup: true,
    sensitive_fields: [
      'prompt',
      'natural_language',
      'query',
      'invoice_refs',
      'selected_material_refs',
      'args',
    ],
  }),
);
