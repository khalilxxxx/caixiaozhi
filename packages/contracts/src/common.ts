import { z } from 'zod';
import { PermissionSchema } from './permissions.js';

export const IdentifierSchema = z.string().min(1);
export const VersionSchema = z.number().int().positive();
export const UtcDateTimeSchema = z.iso.datetime();
export const DataModeSchema = z.enum(['demo', 'production']);

export const BusinessObjectFieldsSchema = z.strictObject({
  id: IdentifierSchema,
  tenant_id: IdentifierSchema,
  version: VersionSchema,
  created_at: UtcDateTimeSchema,
  updated_at: UtcDateTimeSchema,
});

export const RoleSchema = z.enum([
  'employee',
  'manager',
  'finance',
  'platform_admin',
]);
const ActorFieldsSchema = z.strictObject({
  tenant_id: IdentifierSchema,
  user_id: IdentifierSchema,
  roles: z.array(RoleSchema),
  department_ids: z.array(IdentifierSchema),
  permissions: z.array(PermissionSchema),
  authz_version: VersionSchema,
});

export const ActorContextSchema = z.discriminatedUnion('invocation_origin', [
  ActorFieldsSchema.extend({
    session_id: IdentifierSchema,
    invocation_origin: z.literal('interactive'),
    delegation_id: IdentifierSchema.nullable(),
  }),
  ActorFieldsSchema.extend({
    session_id: z.null(),
    invocation_origin: z.literal('subscription'),
    delegation_id: IdentifierSchema,
  }),
]);

export const MoneySchema = z.strictObject({
  amount_minor: z.string().regex(/^(?:0|-?[1-9]\d*)$/),
  currency: z.literal('CNY'),
});

export const ResourceTypeSchema = z.enum([
  'travel',
  'expense_claim',
  'oa_request',
  'rule',
  'skill',
  'policy',
  'analysis',
  'report',
]);

export const ResourceRefSchema = z.strictObject({
  type: ResourceTypeSchema,
  id: IdentifierSchema,
  version: VersionSchema,
});

export const ActionOutcomeSchema = z.enum([
  'succeeded',
  'rejected',
  'failed',
  'unknown',
]);
export const ActionReceiptSchema = z.strictObject({
  id: IdentifierSchema,
  action_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  outcome: ActionOutcomeSchema,
  resource: ResourceRefSchema.nullable(),
  external_receipt_id: IdentifierSchema.nullable(),
  occurred_at: UtcDateTimeSchema,
  data_mode: DataModeSchema,
  error_code: z.string().nullable(),
});

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_user',
  'waiting_confirmation',
  'reconciling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

export const ToolRequestSchema = z.strictObject({
  name: IdentifierSchema,
  version: IdentifierSchema,
  arguments: z.unknown(),
  run_id: IdentifierSchema,
  call_id: IdentifierSchema,
});

export const ToolResultStatusSchema = z.enum([
  'ok',
  'requires_input',
  'requires_confirmation',
  'rejected',
  'error',
  'unknown',
]);

export const ToolResultSchema = z.strictObject({
  status: ToolResultStatusSchema,
  data: z.unknown(),
  evidence_refs: z.array(IdentifierSchema),
  action_id: IdentifierSchema.nullable(),
  error_code: z.string().nullable(),
});

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE',
  'CONFIRMATION_EXPIRED',
  'REVALIDATION_REQUIRED',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
]);

export const ApiErrorSchema = z.strictObject({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ApiResponseMetaSchema = z.strictObject({
  request_id: IdentifierSchema,
  trace_id: IdentifierSchema,
  server_time: UtcDateTimeSchema,
  data_mode: DataModeSchema,
});

export const ApiErrorResponseMetaSchema = ApiResponseMetaSchema.partial({
  server_time: true,
  data_mode: true,
});

export const ApiErrorResponseSchema = z.strictObject({
  error: ApiErrorSchema,
  meta: ApiErrorResponseMetaSchema,
});

export function createApiResponseSchema<Schema extends z.ZodType>(
  dataSchema: Schema,
) {
  return z.union([
    z.strictObject({ data: dataSchema, meta: ApiResponseMetaSchema }),
    ApiErrorResponseSchema,
  ]);
}

export type BusinessObjectFields = z.infer<typeof BusinessObjectFieldsSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type ActorContext = z.infer<typeof ActorContextSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type DataMode = z.infer<typeof DataModeSchema>;
export type ResourceType = z.infer<typeof ResourceTypeSchema>;
export type ResourceRef = z.infer<typeof ResourceRefSchema>;
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiResponseMeta = z.infer<typeof ApiResponseMetaSchema>;
export type ApiErrorResponseMeta = z.infer<typeof ApiErrorResponseMetaSchema>;
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type ApiResponse<Schema extends z.ZodType> = z.infer<
  ReturnType<typeof createApiResponseSchema<Schema>>
>;
