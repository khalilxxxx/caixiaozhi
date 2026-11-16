import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Me,
  PlaceResolution,
  CostCenter,
  Project,
} from '@caixiaozhi/contracts/identity';
import type { Money, ResourceRef } from '@caixiaozhi/contracts/common';
import type { TravelLeg, TravelOperation } from '@caixiaozhi/contracts/travel';
import type {
  ExpenseItem,
  ExpenseOperation,
} from '@caixiaozhi/contracts/expenses';
import type { PreauditResult } from '@caixiaozhi/contracts/preaudit';
import type {
  InteractiveConfirmationReview,
  ActionName,
} from '@caixiaozhi/contracts/actions';
import { api, ApiFailure, formatMoney } from '../../api.js';
import { Drawer, Empty, ErrorNotice, Field, Status } from '../../ui.js';
import type { BusinessDoc, Kind } from './BusinessPage.js';
import { InvoicePanel, MoneyInput, type InvoiceView } from './InvoicePanel.js';
import { PreauditPanel } from './PreauditPanel.js';
import { ConfirmationPanel, prepareConfirmation } from './ConfirmationPanel.js';
import './business.css';
const paths = {
  travel: '/travel',
  expenses: '/expenses/claims',
  oa: '/oa/entertainment',
};
const moneyZero: Money = { amount_minor: '0', currency: 'CNY' };
type Draft = {
  title: string;
  purpose: string;
  cost_center_id?: string | null;
  project_id?: string | null;
  material_refs?: Array<{ id: string; version: number; purpose?: string }>;
  legs?: TravelLeg[];
  items?: ExpenseItem[];
  entertainment_date?: string | null;
  entertained_party?: string;
  budget?: Money | null;
};
type Proposal = {
  id: string;
  base_version: number;
  status: string;
  operations: Array<TravelOperation | ExpenseOperation>;
  clarifications: string[];
};
const fieldLabels: Record<string, string> = {
  title: '标题',
  purpose: '事由',
  cost_center_id: '成本中心',
  project_id: '所属项目',
  from_city_id: '出发城市',
  to_city_id: '到达城市',
  from_place_text: '出发地点原文',
  to_place_text: '到达地点原文',
  departure_date: '出发日期',
  end_date: '结束日期',
  check_in: '入住日期',
  check_out: '退房日期',
  transport_mode: '交通方式',
  transport_budget: '交通预算',
  lodging_required: '是否住宿',
  room_count: '房间数',
  nightly_room_budget: '每间夜预算',
  other_budget: '其他预算',
  other_reason: '其他预算用途',
  expense_type: '费用类型',
  expense_subtype: '费用性质',
  incurred_date: '消费日期',
  claim_amount: '申报金额',
  reduction_reason: '少报说明',
  travel_ref: '关联差旅',
  oa_ref: '关联招待申请',
  lodging_details: '住宿明细',
  transport_details: '交通明细',
};
function diffValue(value: unknown): string {
  if (value === null || value === undefined) return '未填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') {
    if ('amount_minor' in value) return formatMoney(value as Money);
    if ('check_in' in value)
      return `${value.check_in} 至 ${'check_out' in value ? value.check_out : ''}，${'room_count' in value ? value.room_count : ''}间`;
    if ('id' in value)
      return `${value.id}${'version' in value ? `（v${value.version}）` : ''}`;
    return '明细已变化，请展开对应费用核对';
  }
  return String(value);
}
function DiffDescription({
  operation,
  legs = [],
}: {
  operation: TravelOperation | ExpenseOperation;
  legs?: TravelLeg[];
}) {
  if (operation.kind === 'insert_leg' || operation.kind === 'delete_leg') {
    const leg = operation.kind === 'insert_leg' ? operation.leg : operation.old;
    return (
      <span>
        <strong>
          {operation.kind === 'insert_leg' ? '新增行程' : '删除行程'}
        </strong>
        ：{leg.from_place_text ?? leg.from_city_id ?? '出发城市待选'} →{' '}
        {leg.to_place_text ?? leg.to_city_id ?? '到达城市待选'}
        <small>
          {leg.departure_date ?? '出发日待定'} 至 {leg.end_date ?? '结束日待定'}
          ；交通 {formatMoney(leg.transport_budget)}，其他{' '}
          {formatMoney(leg.other_budget)}
          {leg.lodging_required
            ? `；住宿${leg.room_count ?? '待填'}间，每间夜${formatMoney(leg.nightly_room_budget)}`
            : '；无需住宿'}
          。
        </small>
      </span>
    );
  }
  if (operation.kind === 'reorder_legs')
    return (
      <span>
        <strong>重排行程</strong>：共{operation.old.length}
        段，按本次明确列出的顺序调整。
        <small>
          {operation.new
            .map((id) => {
              const index = legs.findIndex((leg) => leg.leg_id === id);
              return index >= 0 ? `原行程${index + 1}` : '本次新增行程';
            })
            .join(' → ')}
          ；已有行程标识保持不变。
        </small>
      </span>
    );
  if (operation.kind === 'insert_item' || operation.kind === 'delete_item') {
    const item =
      operation.kind === 'insert_item' ? operation.item : operation.old;
    const type = {
      transport: '交通',
      lodging: '住宿',
      meals: '餐饮',
      office: '办公',
      other: '其他',
    }[item.expense_type];
    return (
      <span>
        <strong>
          {operation.kind === 'insert_item' ? '新增费用行' : '删除费用行'}
        </strong>
        ：{type}，票据 {item.invoice_id}（v{item.invoice_version}），
        {formatMoney(item.claim_amount)}
        <small>
          消费日期 {item.incurred_date}；
          {item.expense_subtype === 'business_entertainment'
            ? '业务招待；'
            : ''}
          {item.oa_ref ? `关联招待申请 ${item.oa_ref.id}` : '未关联招待申请'}。
        </small>
      </span>
    );
  }
  return (
    <span>
      {fieldLabels[operation.field] ?? '字段'}：
      <del>{diffValue(operation.old)}</del> → {diffValue(operation.new)}
    </span>
  );
}
function draftFrom(
  document: BusinessDoc,
  kind: Exclude<Kind, 'approvals'>,
): Draft {
  const base = { title: document.title, purpose: document.purpose };
  if (kind === 'travel')
    return {
      ...base,
      cost_center_id: document.cost_center_id as string | null,
      project_id: document.project_id as string | null,
      material_refs: document.material_refs as Draft['material_refs'],
      legs: structuredClone(document.legs as TravelLeg[]),
    };
  if (kind === 'expenses')
    return {
      ...base,
      cost_center_id: document.cost_center_id as string | null,
      material_refs: document.material_refs as Draft['material_refs'],
      items: structuredClone(document.items as ExpenseItem[]),
    };
  return {
    ...base,
    entertainment_date: document.entertainment_date as string | null,
    entertained_party: document.entertained_party as string,
    budget: document.budget,
  };
}
function PlaceField({
  label,
  text,
  disabled,
  onChange,
}: {
  label: string;
  text: string | null;
  disabled: boolean;
  onChange: (id: string | null, name: string) => void;
}) {
  const [query, setQuery] = useState(text ?? ''),
    [resolution, setResolution] = useState<PlaceResolution | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  useEffect(() => setQuery(text ?? ''), [text]);
  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      setResolution(
        await api<PlaceResolution>(
          `/master-data/places/resolve?q=${encodeURIComponent(query)}`,
        ),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="place-field">
      <Field label={label}>
        <div className="input-action">
          <input
            disabled={disabled}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setResolution(null);
              onChange(null, event.target.value);
            }}
          />
          <button
            type="button"
            disabled={disabled || busy || !query.trim()}
            onClick={() => void resolve()}
          >
            {busy ? '查询中…' : '查找城市'}
          </button>
        </div>
      </Field>
      <ErrorNotice error={error} />
      {resolution && (
        <div className="place-candidates">
          <p>
            {resolution.requires_selection
              ? '存在多个地点，请明确选择。'
              : '请核对标准城市与行政区映射。'}
          </p>
          {resolution.candidates.length === 0 ? (
            <p>没有找到地点，请调整名称。</p>
          ) : (
            resolution.candidates.map((candidate) => (
              <button
                type="button"
                key={candidate.place_id}
                onClick={() => {
                  onChange(
                    candidate.parent_city?.id ?? candidate.place_id,
                    candidate.name,
                  );
                  setQuery(candidate.name);
                  setResolution(null);
                }}
              >
                <strong>
                  {candidate.name} · {candidate.province_name}
                </strong>
                <small>
                  {candidate.reason}
                  {candidate.parent_city
                    ? `（所属城市：${candidate.parent_city.name}）`
                    : ''}
                </small>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
export function BusinessDocumentDrawer({
  kind,
  id,
  me,
  onClose,
  onChanged,
}: {
  kind: Exclude<Kind, 'approvals'>;
  id: string;
  me: Me;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [document, setDocument] = useState<BusinessDoc | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [remote, setRemote] = useState<BusinessDoc | null>(null),
    [dirty, setDirty] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState('');
  const [centers, setCenters] = useState<CostCenter[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [oaChoices, setOaChoices] = useState<BusinessDoc[]>([]),
    [invoices, setInvoices] = useState(false),
    [preaudit, setPreaudit] = useState(false),
    [preauditResult, setPreauditResult] = useState<PreauditResult | null>(null),
    [ack, setAck] = useState<Set<string>>(new Set()),
    [reason, setReason] = useState(''),
    [issues, setIssues] = useState<Array<{ path: string; message: string }>>(
      [],
    ),
    [review, setReview] = useState<InteractiveConfirmationReview | null>(null);
  const [prompt, setPrompt] = useState(''),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [proposalId, setProposalId] = useState<string | null>(null),
    [proposalSelection, setProposalSelection] = useState<Set<string>>(
      new Set(),
    );
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(
      new Set(),
    ),
    [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set()),
    [proposalInvoices, setProposalInvoices] = useState<InvoiceView[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const load = useCallback(async () => {
    const next = await api<BusinessDoc>(`${paths[kind]}/${id}`);
    setDocument(next);
    setDraft(draftFrom(next, kind));
    setDirty(false);
    setRemote(null);
    setPreauditResult(null);
    return next;
  }, [kind, id]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void load()
      .catch((failure) => {
        if (active) setError(failure);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    void Promise.all([
      api<{ items: CostCenter[] }>(
        `/master-data/cost-centers?business_date=${date}`,
      ),
      api<{ items: Project[] }>(`/master-data/projects?business_date=${date}`),
    ])
      .then(([a, b]) => {
        setCenters(a.items);
        setProjects(b.items);
      })
      .catch(setError);
    if (kind === 'expenses')
      void api<{ items: InvoiceView[] }>('/expenses/invoices?limit=100')
        .then((page) => setProposalInvoices(page.items))
        .catch(setError);
    if (kind === 'expenses')
      void api<{ items: BusinessDoc[] }>(
        '/oa/entertainment?state=approved&limit=100',
      )
        .then((page) => setOaChoices(page.items))
        .catch(setError);
  }, [kind]);
  useEffect(() => {
    setAck(new Set());
  }, [preauditResult?.result_id, preauditResult?.lock_hash]);
  useEffect(() => {
    if (
      !proposalId ||
      (proposal && !['queued', 'running'].includes(proposal.status))
    )
      return;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void api<Proposal>(`${paths[kind]}/${id}/proposals/${proposalId}`)
        .then(setProposal)
        .catch(setError)
        .finally(() => {
          running = false;
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [proposalId, proposal?.status, id, kind]);
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setNotice('');
    setIssues([]);
  };
  const updateLeg = (index: number, patch: Partial<TravelLeg>) => {
    if (draft?.legs)
      update({
        legs: draft.legs.map((leg, i) =>
          i === index ? { ...leg, ...patch } : leg,
        ),
      });
  };
  const updateItem = (index: number, patch: Partial<ExpenseItem>) => {
    if (draft?.items)
      update({
        items: draft.items.map((item, i) =>
          i === index ? { ...item, ...patch } : item,
        ),
      });
  };
  const editable =
    !!document &&
    document.owner_id === me.actor.user_id &&
    ['draft', 'returned', 'withdrawn'].includes(document.state);
  const task = document?.approval_tasks.find(
    (task) => task.state === 'pending' && task.assigned_to === me.actor.user_id,
  );
  const save = async () => {
    if (!draft || !document || !form.current?.reportValidity()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<BusinessDoc>(`${paths[kind]}/${id}`, {
        method: 'PATCH',
        body: { ...draft, expected_version: document.version },
      });
      setDocument(saved);
      setDraft(draftFrom(saved, kind));
      setDirty(false);
      setNotice(`草稿已保存 v${saved.version}。`);
      setPreauditResult(null);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dirty) {
        const latest = await api<BusinessDoc>(`${paths[kind]}/${id}`);
        setRemote(latest);
        setNotice(`服务器当前为v${latest.version}，本地输入仍保留。`);
      } else await load();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    if (!document) return false;
    const result = await api<{
      valid: boolean;
      errors: Array<{ path: string; message: string }>;
    }>(`${paths[kind]}/${id}/validation`);
    setIssues(result.errors);
    if (result.valid) setNotice('当前保存版本的提交字段已通过校验。');
    return result.valid;
  };
  const prepare = async (action: ActionName) => {
    if (!document) return;
    setBusy(true);
    setError(null);
    try {
      if (dirty)
        throw new ApiFailure(
          'VALIDATION_ERROR',
          '请先保存修改，再准备确认。',
          400,
        );
      if (
        !action.endsWith('.withdraw') &&
        action !== 'approval.return' &&
        !(await validate())
      )
        return;
      let args: unknown = {};
      if (action.startsWith('approval.')) {
        if (!task)
          throw new ApiFailure(
            'REVALIDATION_REQUIRED',
            '当前审批节点已变化，请刷新。',
            409,
          );
        if (action === 'approval.return' && !reason.trim())
          throw new ApiFailure(
            'VALIDATION_ERROR',
            '退回需要明确填写补正理由。',
            400,
          );
        if (action === 'approval.approve' && kind === 'expenses') {
          if (!preauditResult || preauditResult.status === 'stale')
            throw new ApiFailure(
              'REVALIDATION_REQUIRED',
              '请先查看当前预审结果。',
              409,
            );
          if (
            preauditResult.group !== 'low' &&
            (!reason.trim() ||
              preauditResult.findings.some((finding) => !ack.has(finding.id)))
          )
            throw new ApiFailure(
              'VALIDATION_ERROR',
              '请确认全部预审发现并填写人工审核理由。',
              400,
            );
        }
        args = {
          task_ref: { id: task.id, version: task.version },
          reason,
          review_ack:
            kind === 'expenses' && preauditResult
              ? {
                  preaudit_result_id: preauditResult.result_id,
                  result_hash: preauditResult.result_hash,
                  lock_hash: preauditResult.lock_hash,
                  acknowledged_finding_ids: [...ack],
                }
              : null,
        };
      }
      setReview(
        await prepareConfirmation({
          action,
          resource_refs: [document.resource_ref],
          args,
        }),
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const addInvoice = (invoice: InvoiceView) => {
    if (!draft?.items) return;
    if (
      !invoice.fields.gross_amount ||
      !invoice.fields.invoice_date ||
      !invoice.fields.expense_type
    ) {
      setError(
        new ApiFailure(
          'VALIDATION_ERROR',
          '请先完整确认票面、日期和费用类型。',
          400,
        ),
      );
      return;
    }
    const existing = draft.items.find((item) => item.invoice_id === invoice.id);
    if (existing) {
      if (existing.invoice_version === invoice.version) {
        setError(
          new ApiFailure(
            'VALIDATION_ERROR',
            '当前票据版本已在这张报销单中。',
            400,
          ),
        );
        return;
      }
      update({
        items: draft.items.map((item) =>
          item.invoice_id === invoice.id
            ? {
                ...item,
                invoice_version: invoice.version,
                expense_type: invoice.fields.expense_type!,
                type_confirmation: 'confirmed',
              }
            : item,
        ),
      });
      setInvoices(false);
      setNotice(
        '已按本次明确选择更新票据版本与类型，原申报金额保留，请核对日期、金额和关联申请后保存。',
      );
      return;
    }
    const item: ExpenseItem = {
      item_id: crypto.randomUUID(),
      invoice_id: invoice.id,
      invoice_version: invoice.version,
      expense_type: invoice.fields.expense_type,
      expense_subtype: null,
      type_confirmation: 'confirmed',
      incurred_date: invoice.fields.invoice_date,
      claim_amount: invoice.fields.gross_amount,
      reduction_reason: null,
      travel_ref: null,
      oa_ref: null,
      lodging_details: null,
      transport_details: null,
    };
    update({ items: [...draft.items, item] });
    setInvoices(false);
  };
  const propose = async () => {
    if (!document) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{
        proposal_id: string;
        status: string;
        base_version: number;
      }>(`${paths[kind]}/${id}/proposals`, {
        method: 'POST',
        body: {
          expected_version: document.version,
          prompt,
          selected_material_refs: (draft?.material_refs ?? []).filter((ref) =>
            selectedMaterials.has(ref.id),
          ),
          ...(kind === 'expenses'
            ? {
                invoice_refs: proposalInvoices
                  .filter((invoice) => selectedInvoices.has(invoice.id))
                  .map((invoice) => ({
                    id: invoice.id,
                    version: invoice.version,
                  })),
              }
            : {}),
        },
      });
      setProposalId(created.proposal_id);
      setProposal({
        id: created.proposal_id,
        status: created.status,
        base_version: created.base_version,
        operations: [],
        clarifications: [],
      });
      setProposalSelection(new Set());
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!document || !proposal) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<BusinessDoc>(
        `${paths[kind]}/${id}/proposals/${proposal.id}/apply`,
        {
          method: 'POST',
          body: {
            expected_version: document.version,
            selected_operation_ids: [...proposalSelection],
          },
        },
      );
      setDocument(saved);
      setDraft(draftFrom(saved, kind));
      setDirty(false);
      setProposal(null);
      setProposalId(null);
      setNotice(`已采纳明确选中的修改，保存为v${saved.version}。`);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const addLeg = () =>
    update({
      legs: [
        ...(draft?.legs ?? []),
        {
          leg_id: `new:${crypto.randomUUID()}`,
          ordinal: (draft?.legs?.length ?? 0) + 1,
          from_city_id: null,
          to_city_id: null,
          from_place_text: null,
          to_place_text: null,
          departure_date: null,
          end_date: null,
          transport_mode: 'train',
          transport_budget: null,
          lodging_required: false,
          check_in: null,
          check_out: null,
          room_count: null,
          nightly_room_budget: null,
          other_budget: moneyZero,
          other_reason: '',
        },
      ],
    });
  return (
    <>
      <Drawer
        title={document?.title ?? '业务单据详情'}
        subtitle={
          document ? `${document.id} · v${document.version}` : undefined
        }
        onClose={onClose}
        dirty={dirty}
        wide
      >
        <ErrorNotice error={error} />
        {loading ? (
          <p role="status">正在读取当前授权单据…</p>
        ) : !document || !draft ? (
          <Empty>未取得可访问的单据，请刷新或返回列表。</Empty>
        ) : (
          <>
            <div className="document-heading">
              <Status value={document.state} />
              <strong className="money">
                {formatMoney(
                  document.total_amount ??
                    document.total_budget ??
                    document.budget,
                )}
              </strong>
              <button disabled={busy} onClick={() => void refresh()}>
                刷新版本
              </button>
            </div>
            {notice && (
              <p className="save-notice" role="status">
                {notice}
              </p>
            )}
            {remote && (
              <div className="unsaved-notice">
                <p>
                  服务器已有v{remote.version}
                  。请保留本地内容比较后，再决定是否载入最新版本。
                </p>
                <button
                  onClick={() => {
                    setDocument(remote);
                    setDraft(draftFrom(remote, kind));
                    setDirty(false);
                    setRemote(null);
                  }}
                >
                  放弃本地修改并载入服务器版本
                </button>
              </div>
            )}
            <form
              ref={form}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={!editable || busy}>
                <Field label="单据标题">
                  <input
                    required
                    maxLength={100}
                    value={draft.title}
                    onChange={(event) => update({ title: event.target.value })}
                  />
                </Field>
                <Field label="申请事由">
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={draft.purpose}
                    onChange={(event) =>
                      update({ purpose: event.target.value })
                    }
                  />
                </Field>
                {kind !== 'oa' && (
                  <div className="form-grid">
                    <Field label="成本中心">
                      <select
                        value={draft.cost_center_id ?? ''}
                        onChange={(event) =>
                          update({ cost_center_id: event.target.value || null })
                        }
                      >
                        <option value="">请选择本人部门的有效中心</option>
                        {draft.cost_center_id &&
                          !centers.some(
                            (center) => center.id === draft.cost_center_id,
                          ) && (
                            <option value={draft.cost_center_id}>
                              {draft.cost_center_id}（原单据成本中心）
                            </option>
                          )}
                        {centers.map((center) => (
                          <option key={center.id} value={center.id}>
                            {center.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {kind === 'travel' && (
                      <Field label="所属项目">
                        <select
                          value={draft.project_id ?? ''}
                          onChange={(event) =>
                            update({ project_id: event.target.value || null })
                          }
                        >
                          <option value="">未指定项目</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                )}
                {kind === 'travel' && (
                  <section className="document-section">
                    <div className="section-heading-inline">
                      <h3>差旅行程</h3>
                      {editable && (
                        <button type="button" onClick={addLeg}>
                          增加一段行程
                        </button>
                      )}
                    </div>
                    {draft.legs?.length === 0 && (
                      <Empty>添加行程后，填写明确的城市、日期与预算。</Empty>
                    )}
                    {draft.legs?.map((leg, index) => (
                      <section className="travel-leg" key={leg.leg_id}>
                        <div className="section-heading-inline">
                          <h4>行程 {index + 1}</h4>
                          {editable && (
                            <button
                              type="button"
                              onClick={() =>
                                update({
                                  legs: draft
                                    .legs!.filter((_, i) => i !== index)
                                    .map((l, i) => ({ ...l, ordinal: i + 1 })),
                                })
                              }
                            >
                              移除此段
                            </button>
                          )}
                        </div>
                        <div className="form-grid">
                          <PlaceField
                            label="出发地点"
                            text={leg.from_place_text ?? leg.from_city_id}
                            disabled={!editable || busy}
                            onChange={(city, name) =>
                              updateLeg(index, {
                                from_city_id: city,
                                from_place_text: name,
                              })
                            }
                          />
                          <PlaceField
                            label="到达地点"
                            text={leg.to_place_text ?? leg.to_city_id}
                            disabled={!editable || busy}
                            onChange={(city, name) =>
                              updateLeg(index, {
                                to_city_id: city,
                                to_place_text: name,
                              })
                            }
                          />
                          <Field label="出发日期">
                            <input
                              type="date"
                              value={leg.departure_date ?? ''}
                              onChange={(e) =>
                                updateLeg(index, {
                                  departure_date: e.target.value || null,
                                })
                              }
                            />
                          </Field>
                          <Field label="返程或结束日期">
                            <input
                              type="date"
                              value={leg.end_date ?? ''}
                              onChange={(e) =>
                                updateLeg(index, {
                                  end_date: e.target.value || null,
                                })
                              }
                            />
                          </Field>
                          <Field label="交通方式">
                            <select
                              value={leg.transport_mode}
                              onChange={(e) =>
                                updateLeg(index, {
                                  transport_mode: e.target
                                    .value as TravelLeg['transport_mode'],
                                })
                              }
                            >
                              <option value="train">火车</option>
                              <option value="flight">飞机</option>
                              <option value="car">汽车</option>
                              <option value="taxi">出租车</option>
                              <option value="other">其他</option>
                            </select>
                          </Field>
                          <Field label="交通预算（元）">
                            <MoneyInput
                              value={leg.transport_budget}
                              onChange={(value) =>
                                updateLeg(index, { transport_budget: value })
                              }
                            />
                          </Field>
                        </div>
                        <label className="checkbox-line">
                          <input
                            type="checkbox"
                            checked={leg.lodging_required}
                            onChange={(e) =>
                              updateLeg(index, {
                                lodging_required: e.target.checked,
                              })
                            }
                          />
                          本段需要住宿
                        </label>
                        {leg.lodging_required && (
                          <div className="form-grid">
                            <Field label="入住日期">
                              <input
                                type="date"
                                value={leg.check_in ?? ''}
                                onChange={(e) =>
                                  updateLeg(index, {
                                    check_in: e.target.value || null,
                                  })
                                }
                              />
                            </Field>
                            <Field label="退房日期">
                              <input
                                type="date"
                                value={leg.check_out ?? ''}
                                onChange={(e) =>
                                  updateLeg(index, {
                                    check_out: e.target.value || null,
                                  })
                                }
                              />
                            </Field>
                            <Field label="房间数">
                              <input
                                type="number"
                                min={1}
                                max={20}
                                value={leg.room_count ?? ''}
                                onChange={(e) =>
                                  updateLeg(index, {
                                    room_count: e.target.value || null,
                                  })
                                }
                              />
                            </Field>
                            <Field label="每间夜预算（元）">
                              <MoneyInput
                                value={leg.nightly_room_budget}
                                onChange={(value) =>
                                  updateLeg(index, {
                                    nightly_room_budget: value,
                                  })
                                }
                              />
                            </Field>
                          </div>
                        )}
                        <div className="form-grid">
                          <Field label="其他预算（元）">
                            <MoneyInput
                              value={leg.other_budget}
                              onChange={(value) =>
                                updateLeg(index, {
                                  other_budget: value ?? moneyZero,
                                })
                              }
                            />
                          </Field>
                          <Field label="其他预算用途">
                            <input
                              maxLength={500}
                              value={leg.other_reason}
                              onChange={(e) =>
                                updateLeg(index, {
                                  other_reason: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </div>
                      </section>
                    ))}
                  </section>
                )}
                {kind === 'oa' && (
                  <div className="form-grid">
                    <Field label="业务招待日期">
                      <input
                        type="date"
                        value={draft.entertainment_date ?? ''}
                        onChange={(e) =>
                          update({ entertainment_date: e.target.value || null })
                        }
                      />
                    </Field>
                    <Field label="招待对象">
                      <input
                        maxLength={200}
                        value={draft.entertained_party ?? ''}
                        onChange={(e) =>
                          update({ entertained_party: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="申请预算（元）">
                      <MoneyInput
                        value={draft.budget}
                        onChange={(value) => update({ budget: value })}
                      />
                    </Field>
                  </div>
                )}
                {kind === 'expenses' && (
                  <section className="document-section">
                    <div className="section-heading-inline">
                      <h3>票据与费用行</h3>
                      {editable && (
                        <button
                          type="button"
                          onClick={() => setInvoices(!invoices)}
                        >
                          {invoices ? '收起票据选择' : '从已确认票据加入费用'}
                        </button>
                      )}
                    </div>
                    {draft.items?.length === 0 && (
                      <Empty>
                        先完成票面核对与费用类型确认，再加入费用行。
                      </Empty>
                    )}
                    {draft.items?.map((item, index) => (
                      <section className="expense-line" key={item.item_id}>
                        <div className="section-heading-inline">
                          <h4>费用 {index + 1}</h4>
                          <small>
                            票据 {item.invoice_id} · v{item.invoice_version}
                          </small>
                          {editable && (
                            <button
                              type="button"
                              onClick={() =>
                                update({
                                  items: draft.items!.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              移除此项
                            </button>
                          )}
                        </div>
                        <div className="form-grid">
                          <Field label="费用类别">
                            <select
                              value={item.expense_type}
                              onChange={(e) =>
                                updateItem(index, {
                                  expense_type: e.target
                                    .value as ExpenseItem['expense_type'],
                                })
                              }
                            >
                              <option value="transport">交通</option>
                              <option value="lodging">住宿</option>
                              <option value="meals">餐饮</option>
                              <option value="office">办公</option>
                              <option value="other">其他</option>
                            </select>
                          </Field>
                          <Field label="消费日期">
                            <input
                              type="date"
                              value={item.incurred_date}
                              onChange={(e) =>
                                updateItem(index, {
                                  incurred_date: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="本次申报金额（元）">
                            <MoneyInput
                              value={item.claim_amount}
                              onChange={(value) => {
                                if (value)
                                  updateItem(index, { claim_amount: value });
                              }}
                            />
                          </Field>
                          <Field label="少报说明（低于票面时必填）">
                            <input
                              value={item.reduction_reason ?? ''}
                              maxLength={500}
                              onChange={(e) =>
                                updateItem(index, {
                                  reduction_reason: e.target.value || null,
                                })
                              }
                            />
                          </Field>
                        </div>
                        {item.expense_type === 'meals' && (
                          <>
                            <label className="checkbox-line">
                              <input
                                type="checkbox"
                                checked={
                                  item.expense_subtype ===
                                  'business_entertainment'
                                }
                                onChange={(e) =>
                                  updateItem(index, {
                                    expense_subtype: e.target.checked
                                      ? 'business_entertainment'
                                      : null,
                                  })
                                }
                              />
                              业务招待餐饮
                            </label>
                            <Field label="关联已批准的招待申请">
                              <select
                                value={item.oa_ref?.id ?? ''}
                                onChange={(e) => {
                                  const oa = oaChoices.find(
                                    (o) => o.id === e.target.value,
                                  );
                                  updateItem(index, {
                                    oa_ref: oa ? oa.resource_ref : null,
                                  });
                                }}
                              >
                                <option value="">
                                  请明确选择匹配业务日期与范围的申请
                                </option>
                                {oaChoices.map((oa) => (
                                  <option key={oa.id} value={oa.id}>
                                    {oa.title} · {oa.id}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          </>
                        )}
                        {item.expense_type === 'lodging' && (
                          <div className="form-grid">
                            <Field label="入住日期">
                              <input
                                type="date"
                                value={item.lodging_details?.check_in ?? ''}
                                onChange={(e) =>
                                  updateItem(index, {
                                    lodging_details: {
                                      check_in: e.target.value,
                                      check_out:
                                        item.lodging_details?.check_out ?? '',
                                      room_count:
                                        item.lodging_details?.room_count ?? '1',
                                    },
                                  })
                                }
                              />
                            </Field>
                            <Field label="退房日期">
                              <input
                                type="date"
                                value={item.lodging_details?.check_out ?? ''}
                                onChange={(e) =>
                                  updateItem(index, {
                                    lodging_details: {
                                      check_in:
                                        item.lodging_details?.check_in ?? '',
                                      check_out: e.target.value,
                                      room_count:
                                        item.lodging_details?.room_count ?? '1',
                                    },
                                  })
                                }
                              />
                            </Field>
                            <Field label="房间数">
                              <input
                                type="number"
                                min={1}
                                max={20}
                                value={item.lodging_details?.room_count ?? ''}
                                onChange={(e) =>
                                  updateItem(index, {
                                    lodging_details: {
                                      check_in:
                                        item.lodging_details?.check_in ?? '',
                                      check_out:
                                        item.lodging_details?.check_out ?? '',
                                      room_count: e.target.value,
                                    },
                                  })
                                }
                              />
                            </Field>
                          </div>
                        )}
                      </section>
                    ))}
                  </section>
                )}
              </fieldset>
              {editable && (
                <div className="drawer-actions">
                  <span>
                    {dirty
                      ? '有未保存修改'
                      : `当前保存版本 v${document.version}`}
                  </span>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={busy || !dirty}
                  >
                    {busy ? '正在保存…' : '保存草稿'}
                  </button>
                </div>
              )}
            </form>
            {invoices && editable && (
              <InvoicePanel
                onChanged={() => {
                  onChanged();
                  void api<{ items: InvoiceView[] }>(
                    '/expenses/invoices?limit=100',
                  )
                    .then((page) => setProposalInvoices(page.items))
                    .catch(setError);
                }}
                onSelect={addInvoice}
              />
            )}
            {(kind === 'travel' || kind === 'expenses') && editable && (
              <section className="document-section">
                <h3>根据当前版本生成修改建议</h3>
                {(draft.material_refs ?? []).length > 0 && (
                  <fieldset>
                    <legend>本轮明确选择的材料</legend>
                    {draft.material_refs!.map((ref) => (
                      <label className="checkbox-line" key={ref.id}>
                        <input
                          type="checkbox"
                          checked={selectedMaterials.has(ref.id)}
                          onChange={(e) =>
                            setSelectedMaterials((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(ref.id);
                              else next.delete(ref.id);
                              return next;
                            })
                          }
                        />
                        <span>
                          {ref.id} · v{ref.version}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                )}
                {kind === 'expenses' && (
                  <fieldset>
                    <legend>本轮明确选择的已确认票据</legend>
                    <p className="muted">
                      只有勾选的票据可作为新增费用依据；本次选择不会直接绑定或提交报销。
                    </p>
                    {proposalInvoices
                      .filter(
                        (invoice) => invoice.confirmation_state === 'confirmed',
                      )
                      .map((invoice) => (
                        <label className="checkbox-line" key={invoice.id}>
                          <input
                            type="checkbox"
                            checked={selectedInvoices.has(invoice.id)}
                            onChange={(e) =>
                              setSelectedInvoices((current) => {
                                const next = new Set(current);
                                if (e.target.checked) next.add(invoice.id);
                                else next.delete(invoice.id);
                                return next;
                              })
                            }
                          />
                          <span>
                            {invoice.fields.invoice_number ?? invoice.id} · v
                            {invoice.version} ·{' '}
                            {formatMoney(invoice.fields.gross_amount)}
                          </span>
                        </label>
                      ))}
                  </fieldset>
                )}
                <Field
                  label="希望修改的内容"
                  hint="先保存手工修改；建议只在你明确采纳后写入。"
                >
                  <textarea
                    value={prompt}
                    rows={2}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </Field>
                <button
                  disabled={busy || dirty || !prompt.trim()}
                  onClick={() => void propose()}
                >
                  生成差异建议
                </button>
                {proposal && (
                  <div className="proposal-diff">
                    <Status value={proposal.status} />
                    {proposal.status === 'failed' && (
                      <p>模型建议未完成，请检查模型配置或继续手工编辑。</p>
                    )}
                    {proposal.clarifications.map((text) => (
                      <p key={text}>{text}</p>
                    ))}
                    {proposal.operations.map((operation) => (
                      <label key={operation.id} className="diff-line">
                        <input
                          type="checkbox"
                          disabled={dirty || proposal.status !== 'proposed'}
                          checked={proposalSelection.has(operation.id)}
                          onChange={(e) =>
                            setProposalSelection((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(operation.id);
                              else next.delete(operation.id);
                              return next;
                            })
                          }
                        />
                        <DiffDescription
                          operation={operation}
                          legs={draft.legs}
                        />
                      </label>
                    ))}
                    {proposal.operations.length > 0 && (
                      <button
                        disabled={
                          busy ||
                          dirty ||
                          proposal.status !== 'proposed' ||
                          proposalSelection.size === 0
                        }
                        onClick={() => void apply()}
                      >
                        采纳明确选中的修改
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
            {kind === 'expenses' && (editable || task) && (
              <section className="document-section">
                <button
                  disabled={dirty || busy}
                  onClick={() => setPreaudit(!preaudit)}
                >
                  {preaudit
                    ? '收起检查详情'
                    : task
                      ? '查看本节点预审与证据'
                      : '进行提交前预检'}
                </button>
                {preaudit && (
                  <PreauditPanel
                    documents={[document.resource_ref]}
                    me={me}
                    purpose={
                      task
                        ? task.node === 'finance'
                          ? 'finance_review'
                          : 'manager_review'
                        : 'employee_precheck'
                    }
                    onResult={setPreauditResult}
                  />
                )}
              </section>
            )}
            {task && (
              <section className="document-section">
                <h3>当前审批决定</h3>
                {kind === 'expenses' && preauditResult && (
                  <div className="review-ack">
                    <p>
                      已查看 <Status value={preauditResult.group} /> ·{' '}
                      {preauditResult.status === 'stale'
                        ? '结论已失效，请重跑'
                        : '当前预审'}
                    </p>
                    {preauditResult.findings.map((finding) => (
                      <label key={finding.id} className="checkbox-line">
                        <input
                          type="checkbox"
                          checked={ack.has(finding.id)}
                          onChange={(e) =>
                            setAck((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(finding.id);
                              else next.delete(finding.id);
                              return next;
                            })
                          }
                        />
                        <span>已核对：{finding.message}</span>
                      </label>
                    ))}
                  </div>
                )}
                <Field
                  label="审核或退回理由"
                  hint="存在风险、材料待核或个人关注时，批准需逐项确认发现并说明人工判断；业务硬阻断仍不能绕过。"
                >
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <div className="button-row">
                  <button
                    disabled={busy}
                    onClick={() => void prepare('approval.return')}
                  >
                    核对退回补正
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || (kind === 'expenses' && !preauditResult)}
                    onClick={() => void prepare('approval.approve')}
                  >
                    核对并准备批准
                  </button>
                </div>
              </section>
            )}
            {issues.length > 0 && (
              <div className="validation-issues" role="alert">
                <h3>需要补充或修正</h3>
                <ul>
                  {issues.map((issue, index) => (
                    <li key={`${issue.path}:${index}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {editable && (
              <div className="button-row">
                <button
                  disabled={busy || dirty}
                  onClick={() => {
                    void validate().catch(setError);
                  }}
                >
                  检查提交条件
                </button>
                <button
                  className="primary-button"
                  disabled={busy || dirty}
                  onClick={() =>
                    void prepare(
                      `${kind === 'expenses' ? 'expense' : kind}.${document.state === 'draft' ? 'submit' : 'resubmit'}` as ActionName,
                    )
                  }
                >
                  核对并准备提交
                </button>
              </div>
            )}
            {document.owner_id === me.actor.user_id &&
              ['pending_manager', 'pending_finance'].includes(
                document.state,
              ) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void prepare(
                      `${kind === 'expenses' ? 'expense' : kind}.withdraw` as ActionName,
                    )
                  }
                >
                  核对撤回当前申请
                </button>
              )}
            {document.history.length > 0 && (
              <section className="document-section">
                <h3>审批记录</h3>
                <ol className="approval-history">
                  {document.history.map((entry) => (
                    <li key={entry.id}>
                      <strong>
                        {entry.decision === 'approve' ? '批准' : '退回'}
                      </strong>
                      <time>
                        {new Date(entry.created_at).toLocaleString('zh-CN')}
                      </time>
                      <p>{entry.reason || '未填写补充说明'}</p>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </Drawer>
      {review && (
        <ConfirmationPanel
          initial={review}
          actorName={me.display_name}
          onClose={() => setReview(null)}
          onChanged={() => {
            onChanged();
            void load().catch(setError);
          }}
        />
      )}
    </>
  );
}
