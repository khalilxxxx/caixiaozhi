import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { AppError } from '@caixiaozhi/platform/errors';
import type { CapabilityDefinition } from '@caixiaozhi/contracts/integrations';
export const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  removeAdditional: false,
  coerceTypes: false,
  useDefaults: false,
  validateFormats: false,
});
const permissionList = z.array(z.string().min(1)).max(50);
export const CapabilityDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().regex(/^finance\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
  effect: z.enum(['read', 'propose', 'write']),
  required_permissions: permissionList,
  connector_id: z.string().min(1),
  timeout_ms: z.number().int().min(1).max(120000),
  supports_idempotency: z.boolean(),
  supports_receipt_lookup: z.boolean(),
  sensitive_fields: z.array(z.string()).optional(),
});
export function validateDefinition(input: unknown): CapabilityDefinition {
  const d = CapabilityDefinitionSchema.parse(input);
  if (
    d.input_schema.type !== 'object' ||
    d.input_schema.additionalProperties !== false
  )
    throw new AppError(
      'VALIDATION_ERROR',
      '能力输入必须使用严格对象 JSON Schema。',
    );
  try {
    ajv.compile(d.input_schema);
    ajv.compile(d.output_schema);
  } catch {
    throw new AppError('VALIDATION_ERROR', '能力 JSON Schema 无效。');
  }
  if (
    d.effect === 'write' &&
    (!d.supports_idempotency || !d.supports_receipt_lookup)
  )
    throw new AppError('INVALID_STATE', '写能力必须支持幂等与回执查询。');
  return d;
}
const reserved = new Set([
  'actor',
  'user_id',
  'tenant_id',
  'roles',
  'permissions',
  'authz_version',
  'session_id',
  'token',
  'confirmation_token',
  'credential_handle',
  'credentials',
  'secret_ref',
  'api_key',
  'apikey',
  'access_key',
  'accesskey',
  'authorization',
  'base_url',
  'baseurl',
  'base_url_ref',
  'callback_url',
  'callbackurl',
  'sql',
  'script',
]);
export function rejectModelCredentials(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(rejectModelCredentials);
    return;
  }
  if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (reserved.has(key.toLowerCase()))
        throw new AppError(
          'VALIDATION_ERROR',
          '工具参数不能提供身份、凭据或执行地址。',
        );
      rejectModelCredentials(item);
    }
}
export function redactArguments(
  value: unknown,
  fields: string[] = [],
): unknown {
  if (Array.isArray(value)) return value.map((v) => redactArguments(v, fields));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        fields.includes(k) ||
        /secret|token|password|authorization|credential|api[_-]?key|access[_-]?key|private[_-]?key|content|invoice|prompt|query|natural_language|reason|body|text/i.test(
          k,
        )
          ? '[已脱敏]'
          : redactArguments(v, fields),
      ]),
    );
  return value;
}
export function removeCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeCredentials);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            !/secret|token|password|authorization|credential|api[_-]?key|access[_-]?key|private[_-]?key|base_?url/i.test(
              k,
            ),
        )
        .map(([k, v]) => [k, removeCredentials(v)]),
    );
  return value;
}
