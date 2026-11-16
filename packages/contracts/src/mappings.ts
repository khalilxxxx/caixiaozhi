import { z } from 'zod';
import { SrsInputSchema, SrsInputSnapshotSchema } from './rules.js';

export const MappingTransformSchema = z.enum([
  'identity',
  'trim_string',
  'date_iso',
  'decimal_yuan_to_minor',
  'enum_lookup',
]);
export const MAPPING_TARGET_FIELDS = [
  'department_id',
  'applicant_id',
  'business_date',
  'total_amount',
  'expense_items[].category',
  'expense_items[].amount',
  'expense_items[].room_nights',
  'expense_items[].source_expense_type',
  'expense_items[].spent_on',
  'invoices[].invoice_number',
  'invoices[].verified',
  'invoices[].amount',
  'travel.start_on',
  'travel.end_on',
  'external_facts.oa_approved',
] as const;
export const MappingFieldSchema = z.strictObject({
  target_field: z.enum(MAPPING_TARGET_FIELDS),
  source_pointer: z.string().max(2000),
  transform: MappingTransformSchema,
  enum_lookup: z
    .record(z.string(), z.union([z.string(), z.boolean()]))
    .optional(),
});
export const MappingConfigSchema = z.strictObject({
  provider: z.string().trim().min(1).max(100),
  source_schema_version: z.string().trim().min(1).max(100),
  module: z.enum(['expense_claim', 'travel', 'oa_request']),
  field_catalog_version: z.literal(1),
  fields: z.array(MappingFieldSchema).min(1).max(100),
});
export const MappingDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  department_ids: z.array(z.string().min(1)).min(1).max(100),
  mapping_json: MappingConfigSchema,
});
export const MappingSaveSchema = MappingDraftSchema.extend({
  expected_version: z.number().int().positive(),
});
export const MappingProviderDocumentSchema = z.strictObject({
  provider: z.string().min(1),
  source_schema_version: z.string().min(1),
  snapshot: SrsInputSnapshotSchema,
  data: z.json(),
  source_states: z
    .record(z.string(), SrsInputSchema.shape.field_states.valueType)
    .optional(),
});
export const MappingTestSchema = z.strictObject({
  expected_version: z.number().int().positive(),
  cases: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        source: MappingProviderDocumentSchema,
        expected: z
          .array(
            z.strictObject({
              target_field: z.string().min(1).max(2000),
              state: z.enum(['known', 'missing', 'unmapped', 'unavailable']),
              value: z.json(),
            }),
          )
          .min(1)
          .max(10000),
      }),
    )
    .min(1)
    .max(20),
});
export const MappingPublishArgsSchema = z.strictObject({
  mapping_id: z.string().min(1),
  expected_version: z.number().int().positive(),
  draft_id: z.string().min(1),
  draft_hash: z.string().regex(/^[a-f0-9]{64}$/),
  test_run_id: z.string().min(1),
});
export type MappingConfig = z.infer<typeof MappingConfigSchema>;
export type MappingDraft = z.infer<typeof MappingDraftSchema>;
export type MappingPublishArgs = z.infer<typeof MappingPublishArgsSchema>;
