import { z } from 'zod';
import { createApiResponseSchema } from './common.js';

export const HealthDependenciesSchema = z.strictObject({
  database: z.enum(['ready', 'unavailable']),
  storage: z.enum(['ready', 'unavailable']),
});

export const HealthDataSchema = z.strictObject({
  service: z.literal('api'),
  status: z.enum(['alive', 'ready', 'not_ready']),
  dependencies: HealthDependenciesSchema.optional(),
});

export const HealthResponseSchema = createApiResponseSchema(HealthDataSchema);
export type HealthDependencies = z.infer<typeof HealthDependenciesSchema>;
export type HealthData = z.infer<typeof HealthDataSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
