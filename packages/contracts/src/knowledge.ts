import { z } from 'zod';
import { ResourceRefSchema, VersionSchema } from './common.js';
import { RuleCategorySchema, RuleModuleSchema } from './rules.js';
export const KnowledgeContextSchema = z.strictObject({
  module: RuleModuleSchema.optional(),
  category: RuleCategorySchema.optional(),
  city_code: z.string().optional(),
  employee_grade: z.string().nullable().optional(),
  travel_start: z.iso.date().nullable().optional(),
  travel_end: z.iso.date().nullable().optional(),
});
export const KnowledgeSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  business_date: z.iso.date(),
  context: KnowledgeContextSchema.optional(),
  top_k: z.number().int().min(1).max(10).default(6),
});
export const KnowledgeQuestionInputSchema = KnowledgeSearchSchema.extend({
  origin_run_id: z.string().min(1),
});
export const GroundedAnswerModelSchema = z.strictObject({
  blocks: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(4000),
        citation_ids: z.array(z.string().min(1)).min(1).max(10),
      }),
    )
    .min(1)
    .max(20),
});
export const PolicyDraftSchema = z
  .strictObject({
    policy_id: z.string().min(1),
    policy_code: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    source_file_id: z.string().min(1),
    organization_ids: z.array(z.string().min(1)).min(1),
    effective_from: z.iso.date(),
    effective_to: z.iso.date().nullable().default(null),
    topic_tags: z.array(z.string()).default([]),
    supersedes_version_id: z.string().nullable().default(null),
  })
  .refine((v) => v.effective_to === null || v.effective_to > v.effective_from);
export const PolicyCitationSchema = z.strictObject({
  citation_id: z.string(),
  policy_ref: ResourceRefSchema,
  chunk_id: z.string(),
  heading_path: z.array(z.string()),
  quote: z.string(),
  start_utf16: z.number().int().nonnegative(),
  end_utf16: z.number().int().nonnegative(),
  quote_hash: z.string(),
  locator: z.strictObject({
    kind: z.literal('text_lines'),
    source_file_id: z.string(),
    normalization_version: z.string(),
    source_start_utf16: z.number().int().nonnegative(),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  }),
  effective_from: z.iso.date(),
  effective_to: z.iso.date().nullable(),
  organization_label: z.string(),
});
export const PolicyPublishSchema = z.strictObject({
  policy_id: z.string(),
  version_id: z.string(),
  expected_version: VersionSchema,
  withdraw: z.boolean().default(false),
});
export type KnowledgeSearch = z.infer<typeof KnowledgeSearchSchema>;
export type PolicyDraftInput = z.infer<typeof PolicyDraftSchema>;
export type PolicyCitation = z.infer<typeof PolicyCitationSchema>;
export type RetrievalSnapshot = {
  retrieval_snapshot_id: string;
  business_date: string;
  hits: PolicyCitation[];
  conflicts: Array<{
    topic_key: string;
    citation_ids: string[];
    message: string;
  }>;
  corpus_revision: number;
};
export type PolicyView = {
  id: string;
  policy_code: string;
  title: string;
  owner_id: string;
  version: number;
  versions: Array<{
    id: string;
    version_no: number;
    version: number;
    publication_state: 'draft' | 'published' | 'withdrawn';
    source_file_id: string;
    content_hash: string;
    organization_ids: string[];
    effective_from: string;
    effective_to: string | null;
    parse_complete: boolean;
    import_id: string | null;
    import_stage: string | null;
  }>;
};
