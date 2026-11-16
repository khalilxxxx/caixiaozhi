import { useEffect, useRef, useState } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type { InteractiveConfirmationReview } from '@caixiaozhi/contracts/actions';
import {
  MappingDraftSchema,
  MappingTestSchema,
  type MappingDraft,
} from '@caixiaozhi/contracts/mappings';
import type { SrsInput, SrsInputSnapshot } from '@caixiaozhi/contracts/rules';
import { api, formatMoney } from '../../api.js';
import { Drawer, Empty, ErrorNotice, Field, Status } from '../../ui.js';
import {
  ConfirmationPanel,
  prepareConfirmation,
} from '../business/ConfirmationPanel.js';
import './mappings.css';

type MappingVersion = {
  id: string;
  version_number: number;
  name: string;
  department_ids: string[];
  mapping_json: MappingDraft['mapping_json'];
  content_hash: string;
  mapping_content_hash: string;
  publication_state: 'draft' | 'published';
  created_by: string;
};
type Mapping = {
  id: string;
  name: string;
  version: number;
  department_ids: string[];
  provider: string;
  source_schema_version: string;
  module: string;
  runtime_binding: 'live_demo' | 'sample_only';
  active_version_id: string | null;
  draft_version_id: string | null;
  versions: MappingVersion[];
};
type Catalog = {
  items: Mapping[];
  identity_fields: MappingDraft['mapping_json']['fields'];
  transforms: string[];
};
type Proof = {
  test_run_id: string;
  draft_id: string;
  draft_hash: string;
  passed: boolean;
  test_set_hash: string;
  mapping_revision: number;
  results: Array<{
    name: string;
    passed: boolean;
    normalized: SrsInputSnapshot;
    checks: Array<{
      target_field: string;
      state: string;
      value: unknown;
      actual: { state: string; value: unknown };
      passed: boolean;
    }>;
  }>;
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const draftVersion = (mapping: Mapping | null) =>
  mapping?.versions.find((version) => version.id === mapping.draft_version_id);
const activeVersion = (mapping: Mapping | null) =>
  mapping?.versions.find((version) => version.id === mapping.active_version_id);
const stateLabels: Record<string, string> = {
  known: '已知',
  missing: '明确缺失',
  unmapped: '未映射',
  unavailable: '来源不可用',
};
const bindingLabel = (binding: Mapping['runtime_binding']) =>
  binding === 'live_demo' ? '已接入演示业务' : '仅人工样例 · 未接业务来源';
const payloadFor = (mapping: Mapping): MappingDraft => {
  const version =
    draftVersion(mapping) ?? activeVersion(mapping) ?? mapping.versions.at(-1)!;
  return {
    name: version.name,
    department_ids: version.department_ids,
    mapping_json: version.mapping_json,
  };
};
function parseDraft(text: string): MappingDraft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('映射草稿不是有效 JSON，请检查引号、逗号和括号。');
  }
  const parsed = MappingDraftSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      '映射草稿结构无效。请保留名称、适用部门和配置，字段与转换使用目录中的固定值。',
    );
  return parsed.data;
}
function parseCases(text: string, version: number) {
  let cases: unknown;
  try {
    cases = JSON.parse(text);
  } catch {
    throw new Error('人工样例不是有效 JSON，请检查引号、逗号和括号。');
  }
  const parsed = MappingTestSchema.safeParse({
    expected_version: version,
    cases,
  });
  if (!parsed.success)
    throw new Error(
      '样例结构无效。请给出 1–20 条完整来源快照及人工预期字段、状态和值。',
    );
  return parsed.data;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function inputHash(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
/** 合成数据与人工固定预期；不调用归一化函数生成预期答案。 */
async function syntheticCases(draft: MappingDraft) {
  const input: SrsInput = {
    schema_version: 1,
    document: {
      type: draft.mapping_json.module,
      id: 'synthetic-mapping-document',
      version: 1,
    },
    business_date: '2026-11-05',
    applicant_id: 'synthetic-applicant',
    department_id: draft.department_ids[0]!,
    total_amount: { amount_minor: '56000', currency: 'CNY' },
    expense_items: [
      {
        id: 'synthetic-line',
        category: 'general',
        source_expense_type: 'office',
        amount: { amount_minor: '56000', currency: 'CNY' },
        invoice_refs: ['synthetic-invoice'],
        spent_on: '2026-11-05',
        room_nights: null,
        oa_request_ref: null,
      },
    ],
    invoices: [
      {
        id: 'synthetic-invoice',
        amount: { amount_minor: '56000', currency: 'CNY' },
        invoice_number: 'SYNTHETIC-ONLY-001',
        verified: true,
      },
    ],
    travel: { start_on: '2026-11-05', end_on: '2026-11-06', request_ref: null },
    external_facts: {
      oa_approved: {
        value: true,
        provenance: 'synthetic-manual-fixture',
        state: 'known',
      },
    },
    field_states: {},
  };
  const manual: Record<string, unknown> = {
    department_id: input.department_id,
    applicant_id: 'synthetic-applicant',
    business_date: '2026-11-05',
    total_amount: { amount_minor: '56000', currency: 'CNY' },
    'expense_items[].category': 'general',
    'expense_items[].source_expense_type': 'office',
    'expense_items[].amount': { amount_minor: '56000', currency: 'CNY' },
    'expense_items[].spent_on': '2026-11-05',
    'expense_items[].room_nights': null,
    'invoices[].invoice_number': 'SYNTHETIC-ONLY-001',
    'invoices[].verified': true,
    'invoices[].amount': { amount_minor: '56000', currency: 'CNY' },
    'travel.start_on': '2026-11-05',
    'travel.end_on': '2026-11-06',
    'external_facts.oa_approved': true,
  };
  const snapshot: SrsInputSnapshot = {
    input,
    provenance: {
      source_ref: input.document,
      materials_version: 1,
      invoice_versions: [{ id: 'synthetic-invoice', version: 1 }],
      external_refs: [],
      field_catalog_version: 1,
      mapping_versions: [],
      normalization_version: 'synthetic-manual-example-v1',
      input_hash: await inputHash(input),
    },
  };
  return [
    {
      name: '合成样例：人工核对 560 元与已核验票据',
      source: {
        provider: draft.mapping_json.provider,
        source_schema_version: draft.mapping_json.source_schema_version,
        snapshot,
        data: { ...input, gross: '560.00' },
      },
      expected: draft.mapping_json.fields.map((field) => ({
        target_field: field.target_field
          .replace('expense_items[]', 'expense_items.synthetic-line')
          .replace('invoices[]', 'invoices.synthetic-invoice'),
        state: manual[field.target_field] === null ? 'missing' : 'known',
        value: manual[field.target_field],
      })),
    },
  ];
}
function Value({ value }: { value: unknown }) {
  if (
    value &&
    typeof value === 'object' &&
    'amount_minor' in value &&
    typeof value.amount_minor === 'string' &&
    /^-?\d+$/.test(value.amount_minor)
  )
    return <>{formatMoney(value as { amount_minor: string })}</>;
  return (
    <>
      {value === null
        ? '明确缺失'
        : typeof value === 'boolean'
          ? value
            ? '是'
            : '否'
          : typeof value === 'string'
            ? value
            : JSON.stringify(value)}
    </>
  );
}

export function MappingsWorkspace({ me }: { me: Me }) {
  const allowed = me.actor.permissions.includes('rule.manage.company');
  const departments = [
    ...new Set(
      me.grants
        .filter(
          (grant) =>
            grant.capability === 'rule.manage.company' &&
            grant.scope_type === 'department',
        )
        .flatMap((grant) => grant.scope_ids),
    ),
  ];
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<Mapping | null>(null),
    [draftText, setDraftText] = useState(''),
    [baseline, setBaseline] = useState('');
  const [casesText, setCasesText] = useState(''),
    [proof, setProof] = useState<Proof | null>(null),
    [proofNote, setProofNote] = useState(''),
    [notice, setNotice] = useState('');
  const [working, setWorking] = useState<string | null>(null),
    [review, setReview] = useState<InteractiveConfirmationReview | null>(null);
  const epoch = useRef(0),
    lifecycle = useRef(0),
    controllers = useRef(new Set<AbortController>());
  const identityKey = `${me.actor.tenant_id}:${me.actor.user_id}:${me.actor.authz_version}`;
  const dirty = draftText !== baseline,
    draft = draftVersion(editing),
    active = activeVersion(editing);
  const request = async <T,>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await api<T>(path, { ...options, signal: controller.signal });
    } finally {
      controllers.current.delete(controller);
    }
  };
  const clearProof = (message: string) => {
    epoch.current++;
    setProof(null);
    setReview(null);
    setProofNote(message);
  };
  const reload = async () => {
    const ticket = lifecycle.current;
    const value = await request<Catalog>('/rule-mappings');
    if (ticket === lifecycle.current) setCatalog(value);
    return value;
  };
  useEffect(() => {
    lifecycle.current++;
    const life = lifecycle.current;
    epoch.current++;
    setOpen(false);
    setEditing(null);
    setProof(null);
    setReview(null);
    setError(null);
    setCatalog(null);
    setLoading(true);
    if (allowed)
      void reload()
        .catch((failure) => {
          if (
            life === lifecycle.current &&
            !(failure instanceof DOMException && failure.name === 'AbortError')
          )
            setError(failure);
        })
        .finally(() => {
          if (life === lifecycle.current) setLoading(false);
        });
    else setLoading(false);
    return () => {
      lifecycle.current++;
      epoch.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [identityKey, allowed]);
  const show = (mapping: Mapping | null) => {
    clearProof('请保存草稿并验证人工样例后再发布。');
    setEditing(mapping);
    setError(null);
    setNotice('');
    setCasesText('');
    const text = pretty(
      mapping
        ? payloadFor(mapping)
        : {
            name: '报销字段规范映射',
            department_ids: departments,
            mapping_json: {
              provider: 'demo-expenses',
              source_schema_version: 'expense-v1',
              module: 'expense_claim',
              field_catalog_version: 1,
              fields: catalog?.identity_fields ?? [],
            },
          },
    );
    setDraftText(text);
    setBaseline(mapping ? text : '');
    setOpen(true);
  };
  const close = () => {
    clearProof('');
    setOpen(false);
    setError(null);
  };
  const save = async () => {
    const ticket = epoch.current,
      life = lifecycle.current;
    setWorking('saving');
    setError(null);
    try {
      const payload = parseDraft(draftText),
        value = await request<Mapping>(
          editing ? `/rule-mappings/${editing.id}/draft` : '/rule-mappings',
          {
            method: editing ? 'PATCH' : 'POST',
            body: editing
              ? { ...payload, expected_version: editing.version }
              : payload,
          },
        );
      if (ticket !== epoch.current || life !== lifecycle.current) return;
      clearProof('草稿已保存；旧证明已清除，请重新验证人工样例。');
      setEditing(value);
      const text = pretty(payloadFor(value));
      setDraftText(text);
      setBaseline(text);
      setNotice(
        value.active_version_id
          ? '新草稿已保存，旧发布版继续生效。完成验证和本人确认后才切换。'
          : '草稿已保存，尚未在业务中生效。',
      );
      await reload();
    } catch (failure) {
      if (ticket === epoch.current && life === lifecycle.current)
        setError(failure);
    } finally {
      if (life === lifecycle.current) setWorking(null);
    }
  };
  const refresh = async () => {
    clearProof('已刷新版本；请重新验证样例，旧证明不能复用。');
    setWorking('refreshing');
    setError(null);
    const life = lifecycle.current;
    try {
      await reload();
      if (editing) {
        const latest = await request<Mapping>(`/rule-mappings/${editing.id}`);
        if (life !== lifecycle.current) return;
        setEditing(latest);
        const text = pretty(payloadFor(latest));
        setBaseline(text);
        if (!dirty) setDraftText(text);
        setNotice(
          dirty
            ? '最新版本已读取，保留你的未保存输入；核对差异后再保存。'
            : '已读取最新版本。',
        );
      }
    } catch (failure) {
      if (life === lifecycle.current) setError(failure);
    } finally {
      if (life === lifecycle.current) setWorking(null);
    }
  };
  const template = async () => {
    setError(null);
    const ticket = epoch.current;
    setWorking('template');
    try {
      const cases = await syntheticCases(parseDraft(draftText));
      if (ticket !== epoch.current) return;
      clearProof('已载入人工固定预期模板；请独立核对后提交真实验证。');
      setCasesText(pretty(cases));
    } catch (failure) {
      if (ticket === epoch.current) setError(failure);
    } finally {
      setWorking(null);
    }
  };
  const test = async () => {
    if (!editing || !draft) return;
    clearProof('正在验证当前草稿的人工样例…');
    const ticket = epoch.current,
      life = lifecycle.current;
    setWorking('testing');
    setError(null);
    try {
      const result = await request<Proof>(
        `/rule-mappings/${editing.id}/tests`,
        { method: 'POST', body: parseCases(casesText, editing.version) },
      );
      if (ticket !== epoch.current || life !== lifecycle.current) return;
      setProof(result);
      setProofNote(
        result.passed
          ? '人工样例已通过，发布前仍会复核权限、草稿与映射依赖。'
          : '人工预期与实际结果不一致，请核对后重新验证；当前不能发布。',
      );
    } catch (failure) {
      if (ticket === epoch.current && life === lifecycle.current) {
        setError(failure);
        setProofNote('本次未获得可用证明，请修正问题后重新验证。');
      }
    } finally {
      if (life === lifecycle.current) setWorking(null);
    }
  };
  const publish = async () => {
    if (!editing || !draft || !proof?.passed) return;
    const ticket = epoch.current,
      life = lifecycle.current;
    setWorking('preparing');
    setError(null);
    try {
      const value = await prepareConfirmation({
        action: 'rule.mapping.publish',
        resource_refs: [],
        args: {
          mapping_id: editing.id,
          expected_version: editing.version,
          draft_id: draft.id,
          draft_hash: draft.content_hash,
          test_run_id: proof.test_run_id,
        },
      });
      if (ticket === epoch.current && life === lifecycle.current)
        setReview(value);
    } catch (failure) {
      if (ticket === epoch.current && life === lifecycle.current) {
        clearProof('发布守卫未通过，旧证明已清除；请读取最新版本并重新验证。');
        setError(failure);
      }
    } finally {
      if (life === lifecycle.current) setWorking(null);
    }
  };
  const published = () => {
    const life = lifecycle.current;
    setWorking('refreshing');
    setProof(null);
    setProofNote('动作已返回，以下方正式回执为准；已清除本地发布证明。');
    void reload()
      .then(async () => {
        if (editing) {
          const latest = await request<Mapping>(`/rule-mappings/${editing.id}`);
          if (life !== lifecycle.current) return;
          setEditing(latest);
          const text = pretty(payloadFor(latest));
          setDraftText(text);
          setBaseline(text);
          const publishedVersion = activeVersion(latest);
          setNotice(
            latest.draft_version_id
              ? '当前草稿尚未发布，旧发布配置保持不变。'
              : publishedVersion
                ? latest.runtime_binding === 'sample_only'
                  ? `第 ${publishedVersion.version_number} 版配置已发布；来源未接业务，不改变实际单据。`
                  : `第 ${publishedVersion.version_number} 版已生效，后续预审使用该映射。`
                : '当前尚无已发布映射。',
          );
        }
      })
      .catch((failure) => {
        if (life === lifecycle.current) setError(failure);
      })
      .finally(() => {
        if (life === lifecycle.current) setWorking(null);
      });
  };
  if (!allowed) return null;
  return (
    <section className="mapping-workspace" aria-label="字段映射治理">
      <div className="mapping-heading">
        <div>
          <h2>字段映射治理</h2>
          <p>
            维护字段来源与转换，用人工样例核对后，通过本人确认切换生效版本。
          </p>
        </div>
        <div className="button-row">
          <button
            disabled={Boolean(working) || loading}
            onClick={() => void refresh()}
          >
            刷新映射
          </button>
          <button
            className="primary-button"
            disabled={loading || !departments.length}
            onClick={() => show(null)}
          >
            创建字段映射
          </button>
        </div>
      </div>
      {!open && <ErrorNotice error={error} />}
      <p className="finance-note">
        演示业务保持规范金额与费用口径。未映射字段保留“未知”，不会当作零值或已通过。
      </p>
      {loading ? (
        <p role="status">正在读取授权映射…</p>
      ) : !catalog ? (
        <p>尚未取得映射列表，请通过“刷新映射”重试。</p>
      ) : !catalog.items.length ? (
        <Empty>
          暂无治理映射，当前业务继续使用既有规范来源。可创建草稿并验证，保存草稿不会改变生效版本。
        </Empty>
      ) : (
        <div className="mapping-list">
          {catalog.items.map((mapping) => {
            const a = activeVersion(mapping),
              d = draftVersion(mapping);
            return (
              <article className="mapping-row" key={mapping.id}>
                <div>
                  <h3>{mapping.name}</h3>
                  <p>{bindingLabel(mapping.runtime_binding)}</p>
                  <p className="mapping-meta">
                    {mapping.provider} / {mapping.source_schema_version} ·{' '}
                    {mapping.module}
                  </p>
                  <p>
                    {mapping.runtime_binding === 'sample_only'
                      ? '发布配置'
                      : '生效版'}
                    ：{a ? `第 ${a.version_number} 版` : '尚未发布'}
                    {d ? `　待发布草稿：第 ${d.version_number} 版` : ''}
                  </p>
                </div>
                <button onClick={() => show(mapping)}>查看与编辑映射</button>
              </article>
            );
          })}
        </div>
      )}
      {open && (
        <Drawer
          title="字段映射配置"
          subtitle={editing ? editing.name : '新建映射草稿'}
          onClose={close}
          dirty={dirty}
          wide
        >
          <ErrorNotice error={error} />
          <div className="mapping-versions" aria-label="映射版本状态">
            <div>
              <span>
                {editing?.runtime_binding === 'sample_only'
                  ? '当前发布配置'
                  : '当前生效'}
              </span>
              <strong>
                {active ? `第 ${active.version_number} 版` : '尚未发布'}
              </strong>
              <small>
                {active
                  ? editing?.runtime_binding === 'sample_only'
                    ? '未接业务来源，此配置不会改变实际单据。'
                    : '保存新草稿期间，仍使用此版。'
                  : '草稿和样例不会自行变更业务。'}
              </small>
            </div>
            <div>
              <span>本次草稿</span>
              <strong>
                {draft ? `第 ${draft.version_number} 版` : '待保存新草稿'}
              </strong>
              <small>
                {editing
                  ? `对象版本 v${editing.version}`
                  : '保存后分配版本与校验值'}
              </small>
            </div>
          </div>
          <p className="finance-note">
            {editing
              ? bindingLabel(editing.runtime_binding)
              : '默认接入演示报销规范来源。'}
            {editing?.runtime_binding === 'sample_only'
              ? ' 当前未注册业务适配器，样例通过不代表真实业务已使用此来源。'
              : ' Demo 字段使用同名规范来源；office、other 固定归为 general，并保留原始费用类型。'}
          </p>
          <Field
            label="映射草稿（JSON）"
            hint="严格包含 name、department_ids、mapping_json。只接受固定字段目录与转换，不执行脚本；保存后旧生效版仍保留。"
          >
            <textarea
              className="finance-editor mapping-editor"
              rows={19}
              spellCheck={false}
              value={draftText}
              disabled={Boolean(working)}
              onChange={(event) => {
                setDraftText(event.target.value);
                setNotice('');
                clearProof('草稿有未保存修改，旧样例证明已失效。');
              }}
            />
          </Field>
          {draft && (
            <details className="mapping-hash">
              <summary>查看草稿身份与校验值</summary>
              <dl>
                <dt>草稿版本</dt>
                <dd>{draft.id}</dd>
                <dt>草稿校验值</dt>
                <dd>{draft.content_hash}</dd>
                <dt>配置校验值</dt>
                <dd>{draft.mapping_content_hash}</dd>
              </dl>
            </details>
          )}
          <div className="button-row">
            <button
              className="primary-button"
              disabled={Boolean(working) || (!dirty && Boolean(draft))}
              onClick={() => void save()}
            >
              {working === 'saving' ? '正在保存…' : '保存映射草稿'}
            </button>
            {editing && (
              <button
                disabled={Boolean(working)}
                onClick={() => void refresh()}
              >
                读取最新已保存版本
              </button>
            )}
          </div>
          {notice && (
            <p className="finance-note" role="status">
              {notice}
            </p>
          )}
          <section className="mapping-samples" aria-label="人工映射样例验证">
            <h3>人工样例验证</h3>
            <p>
              先保存草稿，再独立核对来源快照、字段状态与预期值。金额使用整数分字符串；这里的合成样例不会写入业务单据。
            </p>
            <button
              disabled={Boolean(working) || !draft || dirty}
              onClick={() => void template()}
            >
              {working === 'template'
                ? '正在计算快照校验值…'
                : '载入合成样例模板'}
            </button>
            <Field
              label="人工映射样例（JSON）"
              hint="模板提供人工固定预期并计算真实 input_hash，不代表验证通过。请按配置检查 expected；外部转换样例需自行给出独立预期。"
            >
              <textarea
                className="finance-editor mapping-editor"
                rows={15}
                spellCheck={false}
                value={casesText}
                disabled={Boolean(working)}
                onChange={(event) => {
                  setCasesText(event.target.value);
                  clearProof('样例有修改，旧证明已清除；请重新验证。');
                }}
              />
            </Field>
            <button
              disabled={
                Boolean(working) || !draft || dirty || !casesText.trim()
              }
              onClick={() => void test()}
            >
              {working === 'testing' ? '正在执行真实验证…' : '验证人工映射样例'}
            </button>
            <p className="mapping-proof-state" aria-live="polite">
              {proofNote}
            </p>
            {proof && (
              <div className="mapping-proof">
                <h3>{proof.passed ? '映射样例通过' : '映射样例尚未通过'}</h3>
                <p>
                  证明绑定草稿第 {draft?.version_number} 版 · 映射修订{' '}
                  {proof.mapping_revision}
                </p>
                {proof.results.map((result, index) => (
                  <section
                    className="mapping-case"
                    key={`${index}:${result.name}`}
                  >
                    <h4>
                      {result.name}{' '}
                      <Status
                        value={result.passed ? 'succeeded' : 'failed'}
                        label={result.passed ? '符合人工预期' : '与预期不符'}
                      />
                    </h4>
                    <p>
                      未映射{' '}
                      {
                        Object.values(
                          result.normalized.input.field_states,
                        ).filter((state) => state.state === 'unmapped').length
                      }{' '}
                      项 · 来源不可用{' '}
                      {
                        Object.values(
                          result.normalized.input.field_states,
                        ).filter((state) => state.state === 'unavailable')
                          .length
                      }{' '}
                      项
                    </p>
                    <ul>
                      {result.checks.map((check) => (
                        <li key={check.target_field}>
                          <code>{check.target_field}</code>
                          <span>
                            预期 {stateLabels[check.state]}：
                            <Value value={check.value} />
                          </span>
                          <span>
                            实际 {stateLabels[check.actual.state]}：
                            <Value value={check.actual.value} />
                          </span>
                          <strong>{check.passed ? '符合' : '不符'}</strong>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
                <details className="mapping-hash">
                  <summary>查看证明与样例校验值</summary>
                  <dl>
                    <dt>样例证明</dt>
                    <dd>{proof.test_run_id}</dd>
                    <dt>绑定草稿</dt>
                    <dd>{proof.draft_id}</dd>
                    <dt>样例校验值</dt>
                    <dd>{proof.test_set_hash}</dd>
                  </dl>
                </details>
              </div>
            )}
          </section>
          <section className="mapping-publish">
            <h3>发布前核对</h3>
            <p>
              仅当前草稿的通过证明可准备确认。权限、版本或映射依赖变化时，服务端会拒绝旧证明。
            </p>
            <button
              className="primary-button"
              disabled={
                Boolean(working) ||
                dirty ||
                !draft ||
                !proof?.passed ||
                proof.draft_id !== draft.id ||
                proof.draft_hash !== draft.content_hash
              }
              onClick={() => void publish()}
            >
              {working === 'preparing' ? '正在复核发布条件…' : '核对并发布映射'}
            </button>
          </section>
          {editing && editing.versions.length > 1 && (
            <details className="mapping-history">
              <summary>查看不可变版本记录</summary>
              {editing.versions.map((version) => (
                <div key={version.id}>
                  <strong>
                    第 {version.version_number} 版 ·{' '}
                    {version.id === editing.active_version_id
                      ? '当前生效'
                      : version.publication_state === 'published'
                        ? '历史发布版'
                        : '历史草稿'}
                  </strong>
                  <small>{version.name}</small>
                  <code>{version.content_hash}</code>
                </div>
              ))}
            </details>
          )}
          <details className="mapping-catalog">
            <summary>字段目录与固定转换</summary>
            <p>固定转换：{catalog?.transforms.join('、')}</p>
            <p>
              集合目标用 []，来源数组必须有与快照一致的稳定 id。Demo
              来源使用同名 canonical JSON
              Pointer，不得更换金额、身份或费用含义。
            </p>
            <pre>{pretty(catalog?.identity_fields)}</pre>
          </details>
        </Drawer>
      )}
      {review && (
        <ConfirmationPanel
          initial={review}
          actorName={me.display_name}
          onClose={() => setReview(null)}
          onChanged={published}
        />
      )}
    </section>
  );
}
