import { z } from 'zod';
import { DemoGuardSchema } from './demo.js';
import { ResourceRefSchema } from './common.js';
export const DemoJourneyIdSchema = z.enum([
  'E2E-01',
  'E2E-02',
  'E2E-03',
  'E2E-04',
  'E2E-05',
  'E2E-06',
  'E2E-07',
  'E2E-08',
]);
export const StartDemoJourneySchema = DemoGuardSchema.extend({
  intent: z.literal('run_isolated_demo_journey'),
});
export const DemoJourneyMetadataEvidenceSchema = z.strictObject({
  step_id: z.string().min(1).max(200),
  passed: z.boolean(),
  trace_id: z.string().min(1).max(200),
  resource_refs: z.array(ResourceRefSchema).max(100),
  occurred_at: z.iso.datetime(),
});
export type DemoJourneyMetadataEvidence = z.infer<
  typeof DemoJourneyMetadataEvidenceSchema
>;
