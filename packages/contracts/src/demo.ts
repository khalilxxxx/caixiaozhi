import { z } from 'zod';
export const DEMO_SEED_VERSION = 'finance-agent-v1.0' as const;
export const DemoScenarioSchema = z.enum([
  'baseline',
  'rule-creation',
  'E2E-01',
  'E2E-02',
  'E2E-03',
  'E2E-04',
  'E2E-05',
  'E2E-06',
  'E2E-07',
  'E2E-08',
]);
export const DemoFaultKindSchema = z.enum([
  'ocr.timeout',
  'ocr.low_confidence',
  'preaudit.check_unavailable',
  'action.response_lost_after_commit',
  'adapter.write_outcome_unknown',
  'maas.read_unavailable',
  'sse.disconnect_once',
  'worker.interrupt_once',
]);
export const DemoGuardSchema = z.strictObject({
  expected_generation: z.number().int().positive(),
  expected_environment_version: z.number().int().positive(),
});
export const ResetDemoSchema = DemoGuardSchema.extend({
  seed_version: z.literal(DEMO_SEED_VERSION),
  scenario_id: DemoScenarioSchema.default('baseline'),
  intent: z.literal('reset_demo_environment'),
});
export const DemoFaultSchema = DemoGuardSchema.extend({
  kind: DemoFaultKindSchema,
  scope_alias: z.string().min(1),
  hits: z.number().int().min(1).max(10).default(1),
  ttl_minutes: z.number().int().min(1).max(30).default(5),
});
export const DemoManifestSchema = z.strictObject({
  seed_version: z.literal(DEMO_SEED_VERSION),
  schema_version: z.literal(1),
  alias_map: z.record(z.string(), z.string()),
  expected_counts: z.strictObject({
    users: z.literal(7),
    claims: z.literal(11),
  }),
  assertions: z.array(
    z.strictObject({ name: z.string().min(1), passed: z.boolean() }),
  ),
});
export type DemoManifest = z.infer<typeof DemoManifestSchema>;
export type DemoFaultKind = z.infer<typeof DemoFaultKindSchema>;
export type DemoScenario = z.infer<typeof DemoScenarioSchema>;
