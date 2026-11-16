import { z } from 'zod';
import { ResourceRefSchema, VersionSchema } from './common.js';
import {
  BusinessDateSchema,
  MaterialRefSchema,
  NonNegativeMoneySchema,
  PositiveMoneySchema,
} from './finance-common.js';

export const ExpenseStateSchema = z.enum([
  'draft',
  'pending_manager',
  'pending_finance',
  'completed',
  'returned',
  'withdrawn',
]);
export const ExpenseTypeSchema = z.enum([
  'transport',
  'lodging',
  'meals',
  'office',
  'other',
]);
export const InvoiceFieldsSchema = z.strictObject({
  invoice_number: z.string().min(1).max(64).nullable(),
  invoice_code: z.string().max(64).nullable(),
  invoice_date: BusinessDateSchema.nullable(),
  seller_name: z.string().max(200).nullable(),
  buyer_name: z.string().max(200).nullable(),
  seller_tax_id: z.string().max(64).nullable(),
  buyer_tax_id: z.string().max(64).nullable(),
  gross_amount: NonNegativeMoneySchema.nullable(),
  tax_amount: NonNegativeMoneySchema.nullable(),
  net_amount: NonNegativeMoneySchema.nullable(),
  invoice_kind: z.enum(['electronic', 'paper', 'transport_ticket', 'other']),
  expense_type: ExpenseTypeSchema.nullable(),
});
export const InvoiceConfirmationSchema = z.strictObject({
  expected_version: VersionSchema,
  fields: InvoiceFieldsSchema,
  expense_type: ExpenseTypeSchema,
  expense_subtype: z.literal('business_entertainment').nullable().default(null),
});
export const InvoiceCorrectionSchema = z.strictObject({
  expected_version: VersionSchema,
  corrections: InvoiceFieldsSchema.partial().refine(
    (value) => Object.keys(value).length > 0,
    '至少选择一项票面字段修改',
  ),
  reason: z.string().max(1000).default(''),
});
export const ExpenseItemSchema = z.strictObject({
  item_id: z.string().min(1),
  invoice_id: z.string().min(1),
  invoice_version: VersionSchema,
  expense_type: ExpenseTypeSchema,
  expense_subtype: z.literal('business_entertainment').nullable().default(null),
  type_confirmation: z.enum(['candidate', 'confirmed']),
  incurred_date: BusinessDateSchema,
  claim_amount: PositiveMoneySchema,
  reduction_reason: z.string().min(1).max(500).nullable().default(null),
  travel_ref: ResourceRefSchema.refine((ref) => ref.type === 'travel')
    .nullable()
    .default(null),
  oa_ref: ResourceRefSchema.refine((ref) => ref.type === 'oa_request')
    .nullable()
    .default(null),
  lodging_details: z
    .strictObject({
      check_in: BusinessDateSchema,
      check_out: BusinessDateSchema,
      room_count: z.string().regex(/^(?:[1-9]|1[0-9]|20)$/),
    })
    .nullable()
    .default(null),
  transport_details: z
    .strictObject({
      from_city_id: z.string(),
      to_city_id: z.string(),
      mode: z.enum(['flight', 'train', 'car', 'taxi', 'other']),
    })
    .nullable()
    .default(null),
});
export const ExpenseDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  purpose: z.string().max(2000),
  cost_center_id: z.string().nullable(),
  items: z.array(ExpenseItemSchema).max(100),
  material_refs: z.array(MaterialRefSchema).max(20),
});
export const ExpenseCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).default('未命名报销'),
});
export const ExpenseSaveSchema = ExpenseDraftSchema.extend({
  expected_version: VersionSchema,
});
const expenseOperationFields = {
  id: z.string().min(1),
  evidence_refs: z.array(z.string()).max(40),
};
export const ExpenseOperationSchema = z.union([
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_claim'),
    field: z.enum(['title', 'purpose', 'cost_center_id']),
    old: z.string().nullable(),
    new: z.string().nullable(),
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('expense_type'),
    old: ExpenseTypeSchema,
    new: ExpenseTypeSchema,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('expense_subtype'),
    old: z.literal('business_entertainment').nullable(),
    new: z.literal('business_entertainment').nullable(),
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('incurred_date'),
    old: BusinessDateSchema,
    new: BusinessDateSchema,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('claim_amount'),
    old: PositiveMoneySchema,
    new: PositiveMoneySchema,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('reduction_reason'),
    old: z.string().nullable(),
    new: z.string().nullable(),
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.enum(['travel_ref', 'oa_ref']),
    old: ResourceRefSchema.nullable(),
    new: ResourceRefSchema.nullable(),
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('lodging_details'),
    old: ExpenseItemSchema.shape.lodging_details,
    new: ExpenseItemSchema.shape.lodging_details,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('replace_item'),
    item_id: z.string(),
    field: z.literal('transport_details'),
    old: ExpenseItemSchema.shape.transport_details,
    new: ExpenseItemSchema.shape.transport_details,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('insert_item'),
    temporary_item_key: z.string(),
    after_item_id: z.string().nullable(),
    item: ExpenseItemSchema,
  }),
  z.strictObject({
    ...expenseOperationFields,
    kind: z.literal('delete_item'),
    item_id: z.string(),
    old: ExpenseItemSchema,
  }),
]);
export const ExpenseProposalModelSchema = z.strictObject({
  operations: z.array(ExpenseOperationSchema).max(100),
  clarifications: z.array(z.string()).max(20),
});
export const ExpenseProposalInputSchema = z
  .strictObject({
    expected_version: VersionSchema,
    prompt: z.string().min(1).max(4000),
    selected_material_refs: z.array(MaterialRefSchema).max(20),
    invoice_refs: z
      .array(z.strictObject({ id: z.string().min(1), version: VersionSchema }))
      .max(100),
  })
  .refine(
    (v) =>
      new Set(v.invoice_refs.map((ref) => ref.id)).size ===
      v.invoice_refs.length,
    '本轮票据选择不能重复',
  );
export const ApplyExpenseProposalSchema = z.strictObject({
  expected_version: VersionSchema,
  selected_operation_ids: z.array(z.string().min(1)).min(1).max(100),
});
export type ExpenseOperation = z.infer<typeof ExpenseOperationSchema>;
export const UploadRegistrationSchema = z.strictObject({
  filename: z.string().min(1).max(120),
  mime: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
  size: z.number().int().min(1).max(20_971_520),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExpenseDraft = z.infer<typeof ExpenseDraftSchema>;
export type ExpenseItem = z.infer<typeof ExpenseItemSchema>;
export type InvoiceFields = z.infer<typeof InvoiceFieldsSchema>;
