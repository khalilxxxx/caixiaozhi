import { describe, expect, it } from 'vitest';
import {
  normalize,
  validateMappingConfig,
  providerDocumentFromSnapshot,
  type MappingField,
  type MappingVersion,
  type ProviderDocument,
} from '../../packages/finance/src/mappings.js';
import { canonicalHash } from '../../packages/finance/src/hash.js';
import {
  compileRule,
  evaluateRule,
} from '../../packages/finance/src/evaluator.js';
import {
  SrsInputSnapshotSchema,
  type Predicate,
} from '@caixiaozhi/contracts/rules';
import { personalMealsDsl } from '../../packages/finance/src/rule-seeds.js';

const source = (data: unknown = {}): ProviderDocument => {
  const input = {
    schema_version: 1 as const,
    document: {
      type: 'expense_claim' as const,
      id: 'explicit-mapping-claim',
      version: 4,
    },
    business_date: '2026-11-05',
    applicant_id: 'explicit-owner',
    department_id: 'dept-sales',
    total_amount: { amount_minor: '99999', currency: 'CNY' as const },
    expense_items: [
      {
        id: 'line.a',
        category: 'meals' as const,
        source_expense_type: 'meals',
        amount: { amount_minor: '99999', currency: 'CNY' as const },
        invoice_refs: ['invoice-a'],
        spent_on: '2026-11-04',
        room_nights: '2',
        oa_request_ref: null,
      },
    ],
    invoices: [
      {
        id: 'invoice-a',
        amount: { amount_minor: '99999', currency: 'CNY' as const },
        invoice_number: 'ACTUAL-BASE-NUMBER',
        verified: true,
      },
    ],
    external_facts: {},
    field_states: {},
  };
  return {
    provider: 'explicit-provider',
    source_schema_version: 'explicit-v1',
    data,
    snapshot: {
      input,
      provenance: {
        source_ref: input.document,
        materials_version: 7,
        invoice_versions: [{ id: 'invoice-a', version: 2 }],
        external_refs: [],
        field_catalog_version: 1,
        mapping_versions: [],
        normalization_version: 'explicit-atomic-base-v1',
        input_hash: canonicalHash(input),
      },
    },
  };
};
const field = (
  target_field: string,
  source_pointer: string,
  transform: MappingField['transform'] = 'identity',
): MappingField => ({ target_field, source_pointer, transform });
const mapping = (fields: MappingField[]): MappingVersion => {
  const mapping_json = {
    provider: 'explicit-provider',
    source_schema_version: 'explicit-v1',
    module: 'expense_claim' as const,
    field_catalog_version: 1,
    fields,
  };
  return {
    id: 'explicit-mapping-v3',
    mapping_id: 'explicit-mapping',
    version_number: 3,
    confirmed_by: 'explicit-human-reviewer',
    mapping_json,
    content_hash: canonicalHash(mapping_json),
  };
};
const evaluate = (
  input: ProviderDocument['snapshot']['input'],
  predicate: Predicate,
) =>
  evaluateRule(compileRule({ ...personalMealsDsl(), predicate }), input).truth;
const existsInvoice: Predicate = {
  op: 'for_each',
  collection: 'invoices',
  predicate: {
    op: 'exists',
    value: { op: 'field', path: 'invoice.invoice_number' },
  },
};
describe('人工确认字段映射的受限纯函数执行', () => {
  it('行模板按稳定ID展开，来源数组顺序改变不会串行', () => {
    const original = source({
      lines: [
        { id: 'unrelated', amount: '999.00' },
        { id: 'line.a', amount: '1000.01' },
      ],
    });
    const result = normalize(
      original,
      mapping([
        field(
          'expense_items[].amount',
          '/lines/[]/amount',
          'decimal_yuan_to_minor',
        ),
      ]),
    );
    expect(result.input.expense_items[0]!.amount?.amount_minor).toBe('100001');
    expect(
      result.input.field_states['expense_items.line.a.amount']?.state,
    ).toBe('known');
    const missing = normalize(
      source({ lines: [{ id: 'other', amount: '1.00' }] }),
      mapping([
        field(
          'expense_items[].amount',
          '/lines/[]/amount',
          'decimal_yuan_to_minor',
        ),
      ]),
    );
    expect(
      missing.input.field_states['expense_items.line.a.amount']?.state,
    ).toBe('unavailable');
  });
  it('治理配置拒绝目录外字段、任意代码、重复目标和越权身份映射', () => {
    const config = (fields: unknown) => ({
      provider: 'explicit-provider',
      source_schema_version: 'explicit-v1',
      module: 'expense_claim',
      field_catalog_version: 1,
      fields,
    });
    for (const fields of [
      [field('document.id', '/id')],
      [{ ...field('total_amount', '/amount'), transform: 'eval' }],
      [field('total_amount', '/one'), field('total_amount', '/two')],
      [field('applicant_id', '/forged-owner')],
      [field('total_amount', '/__proto__/value')],
    ])
      expect(() => validateMappingConfig(config(fields))).toThrow();
    expect(
      validateMappingConfig(config([field('total_amount', '/amount')])).fields,
    ).toHaveLength(1);
  });
  it('Demo权威DTO禁止重新解释分类、金额或其它字段来源', () => {
    const config = (fields: MappingField[]) => ({
      provider: 'demo-expenses',
      source_schema_version: 'expense-v1',
      module: 'expense_claim',
      field_catalog_version: 1,
      fields,
    });
    for (const fields of [
      [
        {
          ...field(
            'expense_items[].category',
            '/expense_items/[]/source_expense_type',
            'enum_lookup',
          ),
          enum_lookup: { office: 'transport' },
        },
      ],
      [field('total_amount', '/invoices/0/amount')],
      [field('total_amount', '/total_amount', 'decimal_yuan_to_minor')],
      [field('invoices[].verified', '/invoices/[]/amount')],
    ])
      expect(() => validateMappingConfig(config(fields))).toThrow();
    expect(
      validateMappingConfig(config([field('total_amount', '/total_amount')]))
        .fields,
    ).toHaveLength(1);
  });
  it('真实快照来源不可用状态通过稳定行ID包装传递，不能被identity变为已知', () => {
    const original = source();
    original.snapshot.input.field_states['invoices.invoice-a.verified'] = {
      state: 'unavailable',
      reason: 'VERIFICATION_PENDING',
    };
    original.snapshot.provenance.input_hash = canonicalHash(
      original.snapshot.input,
    );
    const result = normalize(
      providerDocumentFromSnapshot(
        original.snapshot,
        'explicit-provider',
        'explicit-v1',
      ),
      mapping([field('invoices[].verified', '/invoices/[]/verified')]),
    );
    expect(result.input.invoices[0]!.verified).toBe(true);
    expect(
      result.input.field_states['invoices.invoice-a.verified']?.state,
    ).toBe('unavailable');
  });
  it.each([
    ['1000.00', '100000', 'false'],
    ['1000.01', '100001', 'true'],
    ['9007199254740993.01', '900719925474099301', 'true'],
  ])(
    '元金额%s转换后直接供真实解释器判断gt边界，保持整数分%s',
    (amount, minor, truth) => {
      const result = normalize(
        source({ amount, category: 'meals' }),
        mapping([
          field('expense_items.line.a.category', '/category'),
          field(
            'expense_items.line.a.amount',
            '/amount',
            'decimal_yuan_to_minor',
          ),
        ]),
      );
      expect(result.input.expense_items[0]!.amount).toEqual({
        amount_minor: minor,
        currency: 'CNY',
      });
      expect(
        evaluateRule(compileRule(personalMealsDsl()), result.input).truth,
      ).toBe(truth);
    },
  );
  it('显式映射执行五种纯函数，JSON Pointer解码且provenance保留原子版本', () => {
    const original = source({
        department: ' dept-tech ',
        gross: '1000.01',
        category: 'office',
        spent: '2026-11-04T23:30:00-05:00',
        verified: false,
        'a/b': { '~label': '  DEMO-ESCAPED  ' },
      }),
      before = structuredClone(original);
    const result = normalize(
      original,
      mapping([
        field('department_id', '/department', 'trim_string'),
        field('total_amount', '/gross', 'decimal_yuan_to_minor'),
        {
          ...field('expense_items.line.a.category', '/category', 'enum_lookup'),
          enum_lookup: { office: 'general' },
        },
        field('expense_items.line.a.source_expense_type', '/category'),
        field('expense_items.line.a.amount', '/gross', 'decimal_yuan_to_minor'),
        field('expense_items.line.a.spent_on', '/spent', 'date_iso'),
        field(
          'invoices.invoice-a.invoice_number',
          '/a~1b/~0label',
          'trim_string',
        ),
        field('invoices.invoice-a.verified', '/verified'),
      ]),
    );
    expect(result.input.department_id).toBe('dept-tech');
    expect(result.input.total_amount).toEqual({
      amount_minor: '100001',
      currency: 'CNY',
    });
    expect(result.input.expense_items[0]).toMatchObject({
      id: 'line.a',
      category: 'general',
      source_expense_type: 'office',
      amount: { amount_minor: '100001', currency: 'CNY' },
      spent_on: '2026-11-05',
    });
    expect(result.input.invoices[0]).toMatchObject({
      invoice_number: 'DEMO-ESCAPED',
      verified: false,
    });
    expect(result.provenance).toMatchObject({
      source_ref: original.snapshot.provenance.source_ref,
      materials_version: 7,
      invoice_versions: [{ id: 'invoice-a', version: 2 }],
      field_catalog_version: 1,
      mapping_versions: [{ id: 'explicit-mapping-v3', version: 3 }],
    });
    expect(result.provenance.input_hash).toBe(canonicalHash(result.input));
    expect(SrsInputSnapshotSchema.safeParse(result).success).toBe(true);
    expect(original).toEqual(before);
  });
  it('无映射保留基座实际值但解释器必须unknown，不能将未知分类改为general或合规', () => {
    const result = normalize(
      source({ category: 'unknown-provider-category' }),
      mapping([
        {
          ...field('expense_items.line.a.category', '/category', 'enum_lookup'),
          enum_lookup: { office: 'general' },
        },
      ]),
    );
    expect(result.input.expense_items[0]!.category).toBe('meals');
    expect(result.input.total_amount).toEqual({
      amount_minor: '99999',
      currency: 'CNY',
    });
    expect(
      result.input.field_states['expense_items.line.a.category']!.state,
    ).toBe('unmapped');
    expect(result.input.field_states.total_amount!.state).toBe('unmapped');
    expect(
      evaluateRule(compileRule(personalMealsDsl()), result.input).truth,
    ).toBe('unknown');
    expect(evaluate(result.input, existsInvoice)).toBe('unknown');
  });
  it('来源失败覆盖保留值且按稳定行ID记录，重排不迁移未知归属', () => {
    const original = source({ rows: [{ money: '12.00' }] });
    original.snapshot.input.expense_items.push({
      ...original.snapshot.input.expense_items[0]!,
      id: 'other-line',
    });
    original.snapshot.provenance.input_hash = canonicalHash(
      original.snapshot.input,
    );
    original.source_states = {
      '/rows': { state: 'unavailable', reason: '原始敏感错误不应透出' },
    };
    const configured = mapping([
      field(
        'expense_items.line.a.amount',
        '/rows/0/money',
        'decimal_yuan_to_minor',
      ),
    ]);
    const first = normalize(original, configured);
    original.snapshot.input.expense_items.reverse();
    original.snapshot.provenance.input_hash = canonicalHash(
      original.snapshot.input,
    );
    const second = normalize(original, configured);
    expect(first.input.field_states['expense_items.line.a.amount']).toEqual({
      state: 'unavailable',
      reason: 'SOURCE_UNAVAILABLE',
    });
    expect(second.input.field_states['expense_items.line.a.amount']).toEqual(
      first.input.field_states['expense_items.line.a.amount'],
    );
    expect(JSON.stringify(first)).not.toContain('原始敏感错误');
    expect(
      evaluateRule(compileRule(personalMealsDsl()), second.input).truth,
    ).toBe('unknown');
  });
  it.each(['1000.001', 1000.01, '1e3', 'NaN', '1,000.00'])(
    '拒绝非法或浮点元金额%j，不舍入也不把基座金额判为已知',
    (value) => {
      const result = normalize(
        source({ money: value }),
        mapping([field('total_amount', '/money', 'decimal_yuan_to_minor')]),
      );
      expect(result.input.field_states.total_amount).toEqual({
        state: 'unavailable',
        reason: 'MAPPING_TRANSFORM_FAILED',
      });
      expect(
        evaluate(result.input, {
          op: 'compare',
          comparator: 'lt',
          left: { op: 'field', path: 'total_amount' },
          right: {
            op: 'literal',
            value: { amount_minor: '100000', currency: 'CNY' },
          },
        }),
      ).toBe('unknown');
    },
  );
  it('明确null是可靠缺失，缺失Pointer和无时区/无效日期都是unknown', () => {
    const missing = normalize(
      source({ number: null }),
      mapping([field('invoices.invoice-a.invoice_number', '/number')]),
    );
    expect(missing.input.invoices[0]!.invoice_number).toBeNull();
    expect(evaluate(missing.input, existsInvoice)).toBe('false');
    const unavailable = normalize(
      source({}),
      mapping([field('invoices.invoice-a.invoice_number', '/number')]),
    );
    expect(evaluate(unavailable.input, existsInvoice)).toBe('unknown');
    for (const value of ['2026-02-30', '11/05/2026', '2026-11-05T01:00:00']) {
      const result = normalize(
        source({ date: value }),
        mapping([field('expense_items.line.a.spent_on', '/date', 'date_iso')]),
      );
      expect(
        result.input.field_states['expense_items.line.a.spent_on']!.state,
      ).toBe('unavailable');
    }
  });
  it('禁止任意代码、原型路径、目录外字段、重复映射和未确认/改hash版本', () => {
    for (const pointer of [
      '/__proto__/polluted',
      '/constructor/prototype/polluted',
      '/bad~2escape',
      'https://example.com/x',
    ])
      expect(() =>
        normalize(source({}), mapping([field('department_id', pointer)])),
      ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      normalize(source(), mapping([field('__proto__.polluted', '/x')])),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      normalize(source(), mapping([field('employee.salary', '/x')])),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      normalize(
        source(),
        mapping([field('total_amount', '/a'), field('total_amount', '/b')]),
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const code = mapping([field('total_amount', '/a')]);
    (
      code.mapping_json.fields[0] as unknown as { transform: string }
    ).transform = 'eval';
    code.content_hash = canonicalHash(code.mapping_json);
    expect(() => normalize(source(), code)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(() =>
      normalize(source(), { ...mapping([]), confirmed_by: '' }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() =>
      normalize(source(), { ...mapping([]), content_hash: '0'.repeat(64) }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('拒绝重复稳定行ID及带getter的非JSON输入，不调用取值器', () => {
    const duplicate = source();
    duplicate.snapshot.input.invoices.push({
      ...duplicate.snapshot.input.invoices[0]!,
    });
    expect(() => normalize(duplicate, mapping([]))).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    let invoked = false;
    const data = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        invoked = true;
        return 'hidden';
      },
    });
    expect(() =>
      normalize(source(data), mapping([field('department_id', '/value')])),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(invoked).toBe(false);
  });
});
