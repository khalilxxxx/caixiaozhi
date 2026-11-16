import { z } from 'zod';
import { ResourceRefSchema, VersionSchema } from './common.js';
import {
  BusinessDateSchema,
  MaterialRefSchema,
  NonNegativeMoneySchema,
} from './finance-common.js';

export const TravelStateSchema = z.enum([
  'draft',
  'pending_manager',
  'approved',
  'returned',
  'withdrawn',
]);
export const TravelLegSchema = z.strictObject({
  leg_id: z.string().min(1),
  ordinal: z.number().int().min(1).max(20),
  from_city_id: z.string().min(1).nullable(),
  to_city_id: z.string().min(1).nullable(),
  from_place_text: z.string().max(200).nullable().default(null),
  to_place_text: z.string().max(200).nullable().default(null),
  departure_date: BusinessDateSchema.nullable(),
  end_date: BusinessDateSchema.nullable(),
  transport_mode: z.enum(['flight', 'train', 'car', 'taxi', 'other']),
  transport_budget: NonNegativeMoneySchema.nullable(),
  lodging_required: z.boolean(),
  check_in: BusinessDateSchema.nullable(),
  check_out: BusinessDateSchema.nullable(),
  room_count: z
    .string()
    .regex(/^(?:[1-9]|1[0-9]|20)$/)
    .nullable(),
  nightly_room_budget: NonNegativeMoneySchema.nullable(),
  other_budget: NonNegativeMoneySchema,
  other_reason: z.string().max(500),
});
export const TravelDraftSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  purpose: z.string().max(2000),
  cost_center_id: z.string().min(1).nullable(),
  project_id: z.string().min(1).nullable().default(null),
  material_refs: z.array(MaterialRefSchema).max(20),
  legs: z.array(TravelLegSchema).max(20),
});
export const TravelCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(100).default('未命名差旅'),
});
export const TravelSaveSchema = TravelDraftSchema.extend({
  expected_version: VersionSchema,
});
const proposalFields = {
  id: z.string(),
  kind: z.literal('replace'),
  leg_id: z.string(),
  evidence_refs: z.array(z.string()),
};
export const TravelReplaceOperationSchema = z.discriminatedUnion('field', [
  z.strictObject({
    ...proposalFields,
    field: z.enum(['departure_date', 'end_date', 'check_in', 'check_out']),
    old: BusinessDateSchema.nullable(),
    new: BusinessDateSchema.nullable(),
  }),
  z.strictObject({
    ...proposalFields,
    field: z.enum([
      'from_city_id',
      'to_city_id',
      'from_place_text',
      'to_place_text',
      'room_count',
    ]),
    old: z.string().nullable(),
    new: z.string().nullable(),
  }),
  z.strictObject({
    ...proposalFields,
    field: z.enum(['transport_budget', 'nightly_room_budget', 'other_budget']),
    old: NonNegativeMoneySchema.nullable(),
    new: NonNegativeMoneySchema.nullable(),
  }),
  z.strictObject({
    ...proposalFields,
    field: z.literal('lodging_required'),
    old: z.boolean(),
    new: z.boolean(),
  }),
  z.strictObject({
    ...proposalFields,
    field: z.literal('transport_mode'),
    old: TravelLegSchema.shape.transport_mode,
    new: TravelLegSchema.shape.transport_mode,
  }),
  z.strictObject({
    ...proposalFields,
    field: z.literal('other_reason'),
    old: z.string().max(500),
    new: z.string().max(500),
  }),
  z.strictObject({
    ...proposalFields,
    leg_id: z.null(),
    field: z.enum(['title', 'purpose']),
    old: z.string(),
    new: z.string(),
  }),
  z.strictObject({
    ...proposalFields,
    leg_id: z.null(),
    field: z.enum(['cost_center_id', 'project_id']),
    old: z.string().nullable(),
    new: z.string().nullable(),
  }),
]);
const structuralFields = {
  id: z.string().min(1),
  evidence_refs: z.array(z.string()).max(40),
};
export const TravelOperationSchema = z.union([
  TravelReplaceOperationSchema,
  z.strictObject({
    ...structuralFields,
    kind: z.literal('insert_leg'),
    temporary_leg_key: z.string().min(1),
    after_leg_id: z.string().nullable(),
    leg: TravelLegSchema,
  }),
  z.strictObject({
    ...structuralFields,
    kind: z.literal('delete_leg'),
    leg_id: z.string(),
    old: TravelLegSchema,
  }),
  z.strictObject({
    ...structuralFields,
    kind: z.literal('reorder_legs'),
    old: z.array(z.string()).max(20),
    new: z.array(z.string()).max(20),
  }),
]);
export const TravelProposalModelSchema = z.strictObject({
  operations: z.array(TravelOperationSchema).max(100),
  clarifications: z.array(z.string()).max(20),
});
export const TravelProposalInputSchema = z.strictObject({
  expected_version: VersionSchema,
  prompt: z.string().min(1).max(4000),
  selected_material_refs: z.array(MaterialRefSchema).max(20),
  focus_leg_id: z.string().optional(),
});
export const ApplyTravelProposalSchema = z.strictObject({
  expected_version: VersionSchema,
  selected_operation_ids: z.array(z.string().min(1)).min(1).max(100),
});
export type TravelLeg = z.infer<typeof TravelLegSchema>;
export type TravelDraft = z.infer<typeof TravelDraftSchema>;
export type TravelOperation = z.infer<typeof TravelOperationSchema>;
export type TravelDocument = TravelDraft & {
  id: string;
  tenant_id: string;
  owner_id: string;
  department_id: string;
  version: number;
  state: z.infer<typeof TravelStateSchema>;
  total_budget: z.infer<typeof NonNegativeMoneySchema>;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  resource_ref: z.infer<typeof ResourceRefSchema>;
};
