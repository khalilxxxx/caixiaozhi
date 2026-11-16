import { z } from 'zod';
import {
  SrsInputSchema,
  SrsInputSnapshotSchema,
  type SrsInputSnapshot,
  type SrsInput,
} from '@caixiaozhi/contracts/rules';
import { AppError } from '@caixiaozhi/platform/errors';
import {
  FIELD_CATALOG,
  FIELD_CATALOG_VERSION,
  decimalYuanToMinor,
} from './evaluator.js';
import { canonicalHash } from './hash.js';
import {
  MappingConfigSchema,
  type MappingConfig,
} from '@caixiaozhi/contracts/mappings';

export type MappingField = {
  target_field: string;
  source_pointer: string;
  transform:
    | 'identity'
    | 'trim_string'
    | 'date_iso'
    | 'decimal_yuan_to_minor'
    | 'enum_lookup';
  enum_lookup?: Record<string, string | boolean>;
};
export type MappingVersion = {
  id: string;
  mapping_id: string;
  version_number: number;
  confirmed_by: string;
  content_hash: string;
  mapping_json: {
    provider: string;
    source_schema_version: string;
    module: SrsInput['document']['type'];
    field_catalog_version: number;
    fields: MappingField[];
  };
};
/** snapshot为同一次授权读取的结构与稳定行ID基座；data为该版本提供方原始JSON。 */
export type ProviderDocument = {
  provider: string;
  source_schema_version: string;
  snapshot: SrsInputSnapshot;
  data: unknown;
  source_states?: Record<string, SrsInput['field_states'][string]>;
};
export type NormalizedInputWithProvenance = SrsInputSnapshot;
export const MAPPING_NORMALIZATION_VERSION = 'srs-manual-mapping-v1';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const MappingSchema = z.strictObject({
  id: z.string().min(1),
  mapping_id: z.string().min(1),
  version_number: z.number().int().positive(),
  confirmed_by: z.string().trim().min(1),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  mapping_json: z.strictObject({
    provider: z.string().min(1),
    source_schema_version: z.string().min(1),
    module: z.enum(['expense_claim', 'travel', 'oa_request']),
    field_catalog_version: z.literal(FIELD_CATALOG_VERSION),
    fields: z
      .array(
        z.strictObject({
          target_field: z.string().min(1).max(2000),
          source_pointer: z.string().max(2000),
          transform: z.enum([
            'identity',
            'trim_string',
            'date_iso',
            'decimal_yuan_to_minor',
            'enum_lookup',
          ]),
          enum_lookup: z
            .record(z.string(), z.union([z.string(), z.boolean()]))
            .optional(),
        }),
      )
      .max(10000),
  }),
});
function invalid() {
  return new AppError(
    'VALIDATION_ERROR',
    '字段映射或来源不是受支持的已确认 JSON 配置。',
  );
}
/** 不读取getter、不遍历原型、不接受可执行/循环对象；只接受JSON自有数据属性。 */
function assertJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  count = { value: 0 },
): void {
  if (++count.value > 50000 || depth > 32) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return;
  }
  if (typeof value !== 'object') throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw invalid();
  if (seen.has(value)) throw invalid();
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbidden.has(key)) throw invalid();
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in property)) throw invalid();
    assertJson(property.value, depth + 1, seen, count);
  }
  seen.delete(value);
}
function pointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw invalid();
  return path
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~(?:[^01]|$)/.test(token)) throw invalid();
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (forbidden.has(key)) throw invalid();
      return key;
    });
}
/** 治理仅接受固定目录和纯转换；授权坐标只能同源保留。 */
export function validateMappingConfig(value: unknown): MappingConfig {
  assertJson(value);
  const parsed = MappingConfigSchema.safeParse(value);
  if (!parsed.success) throw invalid();
  const configured = new Set<string>();
  for (const field of parsed.data.fields) {
    if (configured.has(field.target_field)) throw invalid();
    configured.add(field.target_field);
    const tokens = pointer(field.source_pointer),
      template = field.target_field.includes('[]'),
      slots = tokens.filter((token) => token === '[]').length;
    if (slots !== (template ? 1 : 0)) throw invalid();
    if (
      ['department_id', 'applicant_id'].includes(field.target_field) &&
      (field.transform !== 'identity' ||
        field.source_pointer !== `/${field.target_field}`)
    )
      throw invalid();
    if (
      field.transform === 'decimal_yuan_to_minor' &&
      !['total_amount', 'expense_items[].amount', 'invoices[].amount'].includes(
        field.target_field,
      )
    )
      throw invalid();
    if (
      field.transform === 'date_iso' &&
      ![
        'business_date',
        'expense_items[].spent_on',
        'travel.start_on',
        'travel.end_on',
      ].includes(field.target_field)
    )
      throw invalid();
    if (field.transform === 'enum_lookup' && !field.enum_lookup)
      throw invalid();
    if (field.transform !== 'enum_lookup' && field.enum_lookup) throw invalid();
    if (
      parsed.data.provider === 'demo-expenses' &&
      parsed.data.source_schema_version === 'expense-v1'
    ) {
      const canonical = DEFAULT_SRS_MAPPING_FIELDS.find(
        (configured) => configured.target_field === field.target_field,
      );
      const fixedCategory =
        field.target_field === 'expense_items[].category' &&
        field.source_pointer === '/expense_items/[]/source_expense_type' &&
        field.transform === 'enum_lookup' &&
        canonicalHash(field.enum_lookup) ===
          canonicalHash(DEMO_EXPENSE_CATEGORY_LOOKUP);
      const stringField = ![
        'total_amount',
        'expense_items[].amount',
        'invoices[].amount',
        'invoices[].verified',
        'external_facts.oa_approved',
      ].includes(field.target_field);
      if (
        !fixedCategory &&
        (!canonical ||
          canonical.source_pointer !== field.source_pointer ||
          !(
            field.transform === 'identity' ||
            (field.transform === 'trim_string' && stringField) ||
            field.transform === 'date_iso'
          ))
      )
        throw invalid();
    }
  }
  return parsed.data;
}

export const DEMO_EXPENSE_CATEGORY_LOOKUP = {
  transport: 'transport',
  lodging: 'lodging',
  meals: 'meals',
  office: 'general',
  other: 'general',
};

export const DEFAULT_SRS_MAPPING_FIELDS: MappingConfig['fields'] = [
  ...['department_id', 'applicant_id', 'business_date', 'total_amount'].map(
    (name) => ({
      target_field: name,
      source_pointer: `/${name}`,
      transform: 'identity',
    }),
  ),
  ...[
    'category',
    'amount',
    'room_nights',
    'source_expense_type',
    'spent_on',
  ].map((name) => ({
    target_field: `expense_items[].${name}`,
    source_pointer: `/expense_items/[]/${name}`,
    transform: 'identity',
  })),
  ...['invoice_number', 'verified', 'amount'].map((name) => ({
    target_field: `invoices[].${name}`,
    source_pointer: `/invoices/[]/${name}`,
    transform: 'identity',
  })),
  {
    target_field: 'travel.start_on',
    source_pointer: '/travel/start_on',
    transform: 'identity',
  },
  {
    target_field: 'travel.end_on',
    source_pointer: '/travel/end_on',
    transform: 'identity',
  },
  {
    target_field: 'external_facts.oa_approved',
    source_pointer: '/external_facts/oa_approved/value',
    transform: 'identity',
  },
] as MappingConfig['fields'];

/** []来源数组通过自有id匹配，永不将位置当作稳定业务行身份。 */
export function expandMappingFields(
  source: ProviderDocument,
  fields: MappingField[],
): MappingField[] {
  return fields.flatMap((field) => {
    if (!field.target_field.includes('[]')) return [field];
    const collection = field.target_field.startsWith('expense_items[]')
      ? 'expense_items'
      : field.target_field.startsWith('invoices[]')
        ? 'invoices'
        : null;
    if (!collection) throw invalid();
    const tokens = pointer(field.source_pointer),
      slot = tokens.indexOf('[]');
    if (slot < 0 || tokens.lastIndexOf('[]') !== slot) throw invalid();
    const raw = lookup(source.data, tokens.slice(0, slot)).value;
    return source.snapshot.input[collection].map((row) => {
      const matches = Array.isArray(raw)
        ? raw.flatMap((item, index) => {
            if (!item || typeof item !== 'object') return [];
            const id = Object.getOwnPropertyDescriptor(item, 'id');
            return id && 'value' in id && id.value === row.id ? [index] : [];
          })
        : [];
      const expanded = [...tokens];
      expanded[slot] = matches.length === 1 ? String(matches[0]) : '-1';
      return {
        ...field,
        target_field: field.target_field.replace('[]', `.${row.id}`),
        source_pointer: `/${expanded.map((token) => token.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`,
      };
    });
  });
}

export function readNormalizedField(
  input: SrsInput,
  path: string,
): { state: string; value: unknown } {
  target(input, path);
  let value: unknown;
  if (path.startsWith('expense_items.') || path.startsWith('invoices.')) {
    const collection = path.startsWith('expense_items.')
        ? 'expense_items'
        : 'invoices',
      rest = path.slice(collection.length + 1),
      last = rest.lastIndexOf('.');
    value = (
      input[collection].find(
        (row) => row.id === rest.slice(0, last),
      ) as unknown as Record<string, unknown>
    )[rest.slice(last + 1)];
  } else if (path === 'external_facts.oa_approved')
    value = input.external_facts.oa_approved?.value ?? null;
  else if (path.startsWith('travel.'))
    value = input.travel?.[path.slice(7) as 'start_on' | 'end_on'] ?? null;
  else value = (input as unknown as Record<string, unknown>)[path];
  return { state: input.field_states[path]?.state ?? 'unmapped', value };
}

/** 只包装已授权原子快照，来源不可用状态继续传入纯归一化。 */
export function providerDocumentFromSnapshot(
  snapshot: SrsInputSnapshot,
  provider: string,
  source_schema_version: string,
): ProviderDocument {
  const source_states: NonNullable<ProviderDocument['source_states']> = {};
  for (const [path, state] of Object.entries(snapshot.input.field_states)) {
    let rawPointer = `/${path.replace(/\./g, '/')}`;
    for (const collection of ['expense_items', 'invoices'] as const) {
      const rest = path.slice(collection.length + 1),
        last = rest.lastIndexOf('.');
      const row = path.startsWith(`${collection}.`)
        ? snapshot.input[collection].find(
            (row) => row.id === rest.slice(0, last),
          )
        : undefined;
      if (row)
        rawPointer = `/${collection}/${snapshot.input[collection].findIndex((candidate) => candidate.id === row.id)}/${path.slice(collection.length + row.id.length + 2)}`;
    }
    if (path === 'external_facts.oa_approved')
      rawPointer = '/external_facts/oa_approved/value';
    source_states[rawPointer] = state;
  }
  if (snapshot.input.external_facts.oa_approved?.state === 'unknown')
    source_states['/external_facts/oa_approved/value'] = {
      state: 'unavailable',
      reason: 'SOURCE_UNAVAILABLE',
    };
  return {
    provider,
    source_schema_version,
    snapshot,
    data: snapshot.input,
    source_states,
  };
}
function lookup(
  data: unknown,
  tokens: string[],
): { found: boolean; value: unknown } {
  let current = data;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object')
      return { found: false, value: null };
    if (
      Array.isArray(current) &&
      (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length)
    )
      return { found: false, value: null };
    const descriptor = Object.getOwnPropertyDescriptor(current, token);
    if (!descriptor || !('value' in descriptor))
      return { found: false, value: null };
    current = descriptor.value;
  }
  return { found: true, value: current };
}
type Target = {
  path: string;
  catalog: string;
  schema: z.ZodType;
  set: (value: unknown) => void;
};
const itemSchemas = SrsInputSchema.shape.expense_items.element.shape;
const invoiceSchemas = SrsInputSchema.shape.invoices.element.shape;
function target(input: SrsInput, path: string): Target {
  if (path.split('.').some((part) => forbidden.has(part))) throw invalid();
  for (const collection of ['expense_items', 'invoices'] as const) {
    if (!path.startsWith(collection + '.')) continue;
    const rest = path.slice(collection.length + 1),
      last = rest.lastIndexOf('.'),
      id = rest.slice(0, last),
      field = rest.slice(last + 1),
      catalog = `${collection === 'expense_items' ? 'item' : 'invoice'}.${field}`;
    const row = input[collection].find((value) => value.id === id);
    const schema = (
      collection === 'expense_items' ? itemSchemas : invoiceSchemas
    )[field as keyof typeof itemSchemas & keyof typeof invoiceSchemas];
    if (last < 1 || !row || !FIELD_CATALOG.has(catalog) || !schema)
      throw invalid();
    return {
      path,
      catalog,
      schema,
      set(value) {
        Object.defineProperty(row, field, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    };
  }
  if (path === 'external_facts.oa_approved')
    return {
      path,
      catalog: path,
      schema: z.boolean().nullable(),
      set(value) {
        input.external_facts.oa_approved = {
          value,
          provenance: '',
          state: value === null ? 'unknown' : 'known',
        };
      },
    };
  if (path === 'travel.start_on' || path === 'travel.end_on') {
    const field = path === 'travel.start_on' ? 'start_on' : 'end_on';
    return {
      path,
      catalog: path,
      schema: z.iso.date().nullable(),
      set(value) {
        input.travel ??= { start_on: null, end_on: null, request_ref: null };
        input.travel[field] = value as string | null;
      },
    };
  }
  if (
    ![
      'department_id',
      'applicant_id',
      'business_date',
      'total_amount',
    ].includes(path)
  )
    throw invalid();
  return {
    path,
    catalog: path,
    schema:
      SrsInputSchema.shape[
        path as
          'department_id' | 'applicant_id' | 'business_date' | 'total_amount'
      ],
    set(value) {
      Object.defineProperty(input, path, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  };
}
function initialStates(input: SrsInput) {
  const paths = [
    'department_id',
    'applicant_id',
    'business_date',
    'total_amount',
    'travel.start_on',
    'travel.end_on',
    'external_facts.oa_approved',
  ];
  for (const row of input.expense_items)
    for (const field of [
      'category',
      'amount',
      'room_nights',
      'source_expense_type',
      'spent_on',
    ])
      paths.push(`expense_items.${row.id}.${field}`);
  for (const row of input.invoices)
    for (const field of ['invoice_number', 'verified', 'amount'])
      paths.push(`invoices.${row.id}.${field}`);
  for (const path of paths)
    input.field_states[path] = {
      state: 'unmapped',
      reason: 'FIELD_NOT_MAPPED',
    };
}
function transform(
  value: unknown,
  field: MappingField,
  catalog: string,
): unknown {
  if (value === null) return null;
  switch (field.transform) {
    case 'identity':
      return structuredClone(value);
    case 'trim_string':
      if (typeof value !== 'string') throw invalid();
      return value.trim() || null;
    case 'date_iso': {
      if (typeof value !== 'string') throw invalid();
      if (z.iso.date().safeParse(value).success) return value;
      if (!z.iso.datetime({ offset: true }).safeParse(value).success)
        throw invalid();
      return new Date(value).toISOString().slice(0, 10);
    }
    case 'decimal_yuan_to_minor':
      if (
        typeof value !== 'string' ||
        !['total_amount', 'item.amount', 'invoice.amount'].includes(catalog)
      )
        throw invalid();
      return { amount_minor: decimalYuanToMinor(value), currency: 'CNY' };
    case 'enum_lookup':
      if (
        typeof value !== 'string' ||
        !field.enum_lookup ||
        !Object.hasOwn(field.enum_lookup, value)
      )
        return undefined;
      return field.enum_lookup[value];
  }
}
/** 只执行已确认不可变版本；调用方仍须在M11发布/取版本时验证权限与状态。 */
export function normalize(
  source: ProviderDocument,
  mapping: MappingVersion,
): NormalizedInputWithProvenance {
  assertJson(source);
  assertJson(mapping);
  const checked = MappingSchema.safeParse(mapping);
  if (!checked.success) throw invalid();
  const version = checked.data;
  if (
    version.mapping_json.provider === 'demo-expenses' &&
    version.mapping_json.source_schema_version === 'expense-v1'
  )
    validateMappingConfig(version.mapping_json);
  if (
    canonicalHash(version.mapping_json) !== version.content_hash ||
    version.mapping_json.provider !== source.provider ||
    version.mapping_json.source_schema_version !== source.source_schema_version
  )
    throw invalid();
  const original = SrsInputSnapshotSchema.safeParse(source.snapshot);
  if (!original.success) throw invalid();
  if (
    canonicalHash(original.data.input) !==
      original.data.provenance.input_hash ||
    original.data.input.document.type !== version.mapping_json.module
  )
    throw invalid();
  const result = structuredClone(original.data),
    input = result.input;
  for (const rows of [input.expense_items, input.invoices])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw invalid();
  const failures = Object.entries(source.source_states ?? {}).map(
    ([path, state]) => {
      const parsed =
        SrsInputSchema.shape.field_states.valueType.safeParse(state);
      if (!parsed.success) throw invalid();
      return { tokens: pointer(path), state: parsed.data.state };
    },
  );
  initialStates(input);
  const configured = new Set<string>();
  for (const field of expandMappingFields(
    source,
    version.mapping_json.fields,
  )) {
    if (configured.has(field.target_field)) throw invalid();
    configured.add(field.target_field);
    const destination = target(input, field.target_field),
      tokens = pointer(field.source_pointer);
    const unavailable = failures.some(
      (failure) =>
        failure.state !== 'known' &&
        failure.tokens.length <= tokens.length &&
        failure.tokens.every((token, index) => tokens[index] === token),
    );
    if (unavailable) {
      input.field_states[destination.path] = {
        state: 'unavailable',
        reason: 'SOURCE_UNAVAILABLE',
      };
      continue;
    }
    const read = lookup(source.data, tokens);
    if (!read.found) {
      input.field_states[destination.path] = {
        state: 'unavailable',
        reason: 'SOURCE_FIELD_MISSING',
      };
      continue;
    }
    try {
      const converted = transform(read.value, field, destination.catalog);
      if (converted === undefined) {
        input.field_states[destination.path] = {
          state: 'unmapped',
          reason: 'ENUM_VALUE_UNMAPPED',
        };
        continue;
      }
      const parsed = destination.schema.safeParse(converted);
      if (!parsed.success) throw invalid();
      destination.set(parsed.data);
      if (destination.catalog === 'external_facts.oa_approved')
        input.external_facts.oa_approved!.provenance = `mapping:${version.id}@${version.version_number}:${field.source_pointer}`;
      input.field_states[destination.path] = {
        state: parsed.data === null ? 'missing' : 'known',
        reason: parsed.data === null ? 'SOURCE_EXPLICITLY_MISSING' : null,
      };
    } catch {
      input.field_states[destination.path] = {
        state: 'unavailable',
        reason: 'MAPPING_TRANSFORM_FAILED',
      };
    }
  }
  result.provenance = {
    ...result.provenance,
    field_catalog_version: FIELD_CATALOG_VERSION,
    mapping_versions: [{ id: version.id, version: version.version_number }],
    normalization_version: MAPPING_NORMALIZATION_VERSION,
    input_hash: canonicalHash(input),
  };
  return SrsInputSnapshotSchema.parse(result);
}
