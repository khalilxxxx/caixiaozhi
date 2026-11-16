import { z } from 'zod';
import { MoneySchema, ResourceRefSchema } from './common.js';
export const MetricIdSchema = z.enum([
  'expense.completed_amount',
  'expense.completed_count',
  'expense.submitted_amount',
  'expense.pending_manager_amount',
  'expense.pending_manager_count',
  'expense.low_candidate_amount',
  'expense.low_candidate_count',
  'expense.entertainment_completed_amount',
  'expense.category_completed_amount',
]);
export type MetricId = z.infer<typeof MetricIdSchema>;
export const DimensionSchema = z.enum([
  'applicant',
  'department',
  'expense_type',
  'completed_day',
  'completed_month',
  'submitted_day',
  'submitted_month',
]);
export const QueryPlanSchema = z.strictObject({
  metric: MetricIdSchema,
  period: z.union([
    z.strictObject({
      from: z.iso.date(),
      to_exclusive: z.iso.date(),
      timezone: z.literal('Asia/Shanghai'),
      date_basis: z.enum(['completed_at', 'submitted_at']),
      compare_to: z
        .strictObject({ from: z.iso.date(), to_exclusive: z.iso.date() })
        .optional(),
    }),
    z.strictObject({
      as_of: z.literal('current'),
      timezone: z.literal('Asia/Shanghai'),
      date_basis: z.literal('snapshot_at'),
    }),
  ]),
  dimensions: z.array(DimensionSchema).max(2).default([]),
  filters: z
    .strictObject({
      scope: z.enum(['self', 'department', 'authorized_departments']),
      department_ids: z.array(z.string().min(1)).max(50).optional(),
      applicant_ids: z.array(z.string().min(1)).max(100).optional(),
      expense_types: z
        .array(z.enum(['transport', 'lodging', 'meals', 'office', 'other']))
        .max(5)
        .optional(),
      top_n: z.number().int().min(1).max(500).optional(),
    })
    .default({ scope: 'self' }),
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;
export const ChartSpecSchema = z.strictObject({
  spec_version: z.literal(1),
  type: z.enum(['bar', 'line', 'donut', 'table']),
  snapshot_id: z.string(),
  unit: z.enum(['CNY_minor', 'count']),
  rows: z.array(
    z.strictObject({
      dimension_key: z.string(),
      label: z.string(),
      value: z.string(),
      fact_refs: z.array(z.string()),
    }),
  ),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;
export const AnalysisFactSchema = z.strictObject({
  id: z.string(),
  fact_kind: z.enum(['claim', 'line']),
  claim_ref: ResourceRefSchema,
  line_id: z.string().nullable(),
  line_version: z.number().int().positive().nullable(),
  applicant_id: z.string(),
  department_id: z.string(),
  expense_type: z.string().nullable(),
  amount_minor: MoneySchema.shape.amount_minor,
  submitted_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  state: z.string(),
  entertainment_valid: z.boolean().nullable(),
});
export type AnalysisFact = z.infer<typeof AnalysisFactSchema>;
export const ReportTemplateSchema = z.enum([
  'monthly_expense',
  'daily_expense',
]);
export const EditableBlocksSchema = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  narrative: z.string().max(10000).optional(),
  recommendations: z.string().max(10000).optional(),
  user_note: z.string().max(10000).optional(),
});
export const ExportCommandSchema = z.strictObject({
  expected_version: z.number().int().positive(),
  format: z.enum(['csv', 'html']),
  freshness_choice: z.enum(['as_recorded', 'refresh']),
});
export type MetricDefinition = {
  metric_id: MetricId;
  grain: 'claim' | 'line';
  unit: 'CNY_minor' | 'count';
  date_basis: 'completed_at' | 'submitted_at' | 'snapshot_at';
  allowed_dimensions: Array<z.infer<typeof DimensionSchema>>;
  catalog_version: string;
};
