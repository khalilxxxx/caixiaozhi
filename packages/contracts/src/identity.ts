import { z } from 'zod';
import {
  ActorContextSchema,
  IdentifierSchema,
  RoleSchema,
  VersionSchema,
} from './common.js';
import { PermissionSchema } from './permissions.js';

const ExplicitIdSchema = IdentifierSchema.refine(
  (id) => !id.includes('*'),
  '范围必须使用明确标识',
);
export const GrantScopeSchema = z.enum([
  'self',
  'department',
  'assigned_task',
  'named_resource',
  'operations',
]);
export const GrantSchema = z.strictObject({
  capability: PermissionSchema,
  scope_type: GrantScopeSchema,
  scope_ids: z
    .array(ExplicitIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
  effect: z.literal('allow'),
});
export const GrantChangeSchema = z.strictObject({
  expected_version: VersionSchema,
  grants: z.array(GrantSchema),
  reason: z.string().min(1).max(500),
});
export const DemoLoginInputSchema = z.strictObject({
  demo_environment_id: IdentifierSchema,
  generation: VersionSchema,
  selected_user_id: IdentifierSchema,
});
export const DemoSwitchInputSchema = z.strictObject({
  selected_user_id: IdentifierSchema,
  generation: VersionSchema,
});
export const PersonCandidateSchema = z.strictObject({
  id: IdentifierSchema,
  display_name: z.string().min(1),
  department_id: IdentifierSchema,
  department_name: z.string().min(1),
  position: z.string().min(1),
});
export const DepartmentSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  parent_id: IdentifierSchema.nullable(),
  manager_user_id: IdentifierSchema.nullable(),
  state: z.enum(['active', 'inactive']),
  version: VersionSchema,
});
export const AuthorizationGroupSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  state: z.enum(['active', 'inactive']),
  source: z.string().min(1),
  version: VersionSchema,
});
export const CostCenterSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  department_id: IdentifierSchema,
  valid_from: z.iso.date(),
  valid_to: z.iso.date().nullable(),
  state: z.enum(['active', 'inactive']),
  version: VersionSchema,
});
export const ProjectSchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  department_id: IdentifierSchema,
  state: z.enum(['active', 'inactive']),
  version: VersionSchema,
});
export const ParentCitySchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1),
  standard_code: z.string().min(1),
});
export const PlaceCandidateSchema = z.strictObject({
  place_id: IdentifierSchema,
  name: z.string().min(1),
  level: z.enum(['city', 'district']),
  standard_code: z.string().min(1),
  province_name: z.string().min(1),
  parent_city: ParentCitySchema.nullable(),
  reason: z.string().min(1),
});
export const PlaceResolutionSchema = z
  .strictObject({
    input: z.string(),
    mapping_version: z.string().min(1),
    requires_selection: z.boolean(),
    candidates: z.array(PlaceCandidateSchema),
  })
  .refine(
    (value) => value.candidates.length <= 1 || value.requires_selection,
    '多个候选必须由用户选择',
  );
export const MeSchema = z.strictObject({
  actor: ActorContextSchema,
  display_name: z.string().min(1),
  department_id: IdentifierSchema,
  department_name: z.string().min(1),
  roles: z.array(RoleSchema),
  grants: z.array(GrantSchema),
  csrf_token: z.string().min(1).nullable(),
  generation: VersionSchema,
});
export type Grant = z.infer<typeof GrantSchema>;
export type GrantChange = z.infer<typeof GrantChangeSchema>;
export type DemoLoginInput = z.infer<typeof DemoLoginInputSchema>;
export type PersonCandidate = z.infer<typeof PersonCandidateSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type AuthorizationGroup = z.infer<typeof AuthorizationGroupSchema>;
export type CostCenter = z.infer<typeof CostCenterSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type PlaceResolution = z.infer<typeof PlaceResolutionSchema>;
export type Me = z.infer<typeof MeSchema>;
