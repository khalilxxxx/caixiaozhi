import { z } from 'zod';
import { AgentCardTypeSchema } from './cards.js';
import { ActionNameSchema } from './actions.js';
export const SkillManifestSchema = z.strictObject({
  manifest_schema_version: z.literal(1),
  title: z.string().min(1).max(32),
  summary: z.string().min(1).max(120),
  intent_examples: z.array(z.string().min(1).max(1000)).min(1).max(8),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
  tools: z
    .array(
      z.strictObject({
        capability_version_id: z.string().min(1).max(200),
        required: z.boolean(),
      }),
    )
    .max(12),
  scope_policy: z.strictObject({
    preset: z.enum([
      'self',
      'current_approval_assignments',
      'authorized_departments',
    ]),
    department_ids: z.array(z.string().min(1)).max(50).optional(),
  }),
  allowed_action_operations: z.array(ActionNameSchema).max(20),
  output_card_types: z.array(AgentCardTypeSchema).min(1).max(10),
  examples: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        input: z.unknown(),
        expected: z.unknown(),
        expected_tool_names: z.array(z.string().min(1)).max(12),
        expectation: z.enum(['success', 'clarify', 'deny']),
      }),
    )
    .min(1)
    .max(5),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export const SkillVersionStatusSchema = z.enum([
  'draft',
  'validating',
  'validated',
  'review_pending',
  'approved',
  'rejected',
  'published',
]);
export const SkillValidationStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'blocked',
  'cancelled',
]);
export const SkillReviewStatusSchema = z.enum([
  'review_pending',
  'approved',
  'rejected',
  'withdrawn',
]);
export const SkillScopeSchema = z.enum(['personal', 'group', 'tenant']);
export const SkillGrantSchema = z.strictObject({
  subject_type: z.enum(['user', 'group', 'tenant']),
  subject_id: z.string().min(1),
  action: z.enum(['use', 'source_read', 'maintain', 'review', 'publish']),
  expires_at: z.iso.datetime().nullable().optional(),
});
export type SkillGrant = z.infer<typeof SkillGrantSchema>;
export const RequestedSkillScopeSchema = z.strictObject({
  scope: z.enum(['group', 'tenant']),
  group_ids: z.array(z.string().min(1)).max(50).optional(),
});
export type RequestedSkillScope = z.infer<typeof RequestedSkillScopeSchema>;
export type FrozenSkill = {
  skill_id: string;
  skill_version_id: string;
  version_number: number;
  content_hash: string;
  markdown: string;
  manifest: SkillManifest;
  capability_versions: string[];
  revocation_epoch: number;
};
export const SelectionPlanSchema = z.discriminatedUnion('selection', [
  z.strictObject({
    selection: z.literal('selected'),
    skill_id: z.string(),
    skill_version_id: z.string(),
    title: z.string(),
    version_number: z.number().int().positive(),
    selected_by: z.enum(['explicit', 'automatic', 'continuation']),
    reason: z.string(),
  }),
  z.strictObject({ selection: z.literal('none'), reason: z.string() }),
  z.strictObject({
    selection: z.literal('clarify'),
    candidates: z
      .array(
        z.strictObject({
          skill_id: z.string(),
          skill_version_id: z.string(),
          title: z.string(),
          reason: z.string(),
        }),
      )
      .max(3),
    question: z.string(),
  }),
]);
export type SelectionPlan = z.infer<typeof SelectionPlanSchema>;
