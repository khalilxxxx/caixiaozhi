import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type { ResourceRef, Money } from '@caixiaozhi/contracts/common';
import type { InteractiveConfirmationReview } from '@caixiaozhi/contracts/actions';
import { api, ApiFailure, formatMoney } from '../../api.js';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  SectionTitle,
  Status,
} from '../../ui.js';
import { BusinessDocumentDrawer } from './BusinessDocumentDrawer.js';
import { InvoicePanel } from './InvoicePanel.js';
import { PreauditPanel } from './PreauditPanel.js';
import { ConfirmationPanel, prepareConfirmation } from './ConfirmationPanel.js';
export type BusinessDoc = {
  id: string;
  tenant_id: string;
  owner_id: string;
  department_id: string;
  version: number;
  state: string;
  title: string;
  purpose: string;
  resource_ref: ResourceRef;
  total_budget?: Money;
  total_amount?: Money;
  budget?: Money | null;
  approval_tasks: Array<{
    id: string;
    version: number;
    assigned_to: string;
    node: string;
    state: string;
    resource_version: number;
  }>;
  history: Array<{
    id: string;
    decision: string;
    reason: string;
    actor_id: string;
    created_at: string;
  }>;
  [field: string]: unknown;
};
export type Kind = 'travel' | 'expenses' | 'oa' | 'approvals';
const titles: Record<Kind, string> = {
  travel: '差旅申请',
  expenses: '票据与报销',
  oa: '前置申请',
  approvals: '待我审批',
};
const paths: Record<Exclude<Kind, 'approvals'>, string> = {
  travel: '/travel',
  expenses: '/expenses/claims',
  oa: '/oa/entertainment',
};
export function BusinessPage({ kind, me }: { kind: Kind; me: Me }) {
  const [items, setItems] = useState<BusinessDoc[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [document, setDocument] = useState<{
    kind: Exclude<Kind, 'approvals'>;
    id: string;
  } | null>(() => {
    const q = new URLSearchParams(location.search),
      type = q.get('drawer'),
      id = q.get('resource');
    return id && ['travel', 'expense_claim', 'oa_request'].includes(type ?? '')
      ? {
          kind:
            type === 'travel'
              ? 'travel'
              : type === 'expense_claim'
                ? 'expenses'
                : 'oa',
          id,
        }
      : null;
  });
  const [showInvoices, setShowInvoices] = useState(false),
    [preauditRefs, setPreauditRefs] = useState<ResourceRef[] | null>(null),
    [review, setReview] = useState<InteractiveConfirmationReview | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (kind === 'approvals') {
        const page = await api<{ items: Array<{ document: BusinessDoc }> }>(
          '/approvals?limit=100',
        );
        setItems(page.items.map((row) => row.document));
      } else {
        const page = await api<{ items: BusinessDoc[] }>(
          `${paths[kind]}?limit=100`,
        );
        setItems(page.items);
      }
    } catch (failure) {
      setError(failure);
      if (
        failure instanceof ApiFailure &&
        [401, 403, 404].includes(failure.status)
      )
        setItems([]);
    } finally {
      setLoading(false);
    }
  }, [kind]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const open = (item: BusinessDoc) => {
    const type = item.resource_ref.type;
    const next = {
      kind:
        type === 'travel'
          ? ('travel' as const)
          : type === 'expense_claim'
            ? ('expenses' as const)
            : ('oa' as const),
      id: item.id,
    };
    setDocument(next);
    const url = new URL(location.href);
    url.searchParams.set('drawer', type);
    url.searchParams.set('resource', item.id);
    history.pushState(null, '', url);
  };
  const close = useCallback(() => {
    setDocument(null);
    const url = new URL(location.href);
    url.searchParams.delete('drawer');
    url.searchParams.delete('resource');
    history.pushState(null, '', url);
  }, []);
  useEffect(() => {
    const update = () => {
      const query = new URLSearchParams(location.search),
        id = query.get('resource'),
        type = query.get('drawer');
      setDocument(
        id && ['travel', 'expense_claim', 'oa_request'].includes(type ?? '')
          ? {
              kind:
                type === 'travel'
                  ? 'travel'
                  : type === 'expense_claim'
                    ? 'expenses'
                    : 'oa',
              id,
            }
          : null,
      );
    };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const create = async () => {
    if (kind === 'approvals') return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<BusinessDoc>(paths[kind], {
        method: 'POST',
        body: {},
      });
      open(created);
      await reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const total = items.reduce(
    (sum, item) =>
      sum +
      BigInt(
        (item.total_amount ?? item.total_budget ?? item.budget)?.amount_minor ??
          '0',
      ),
    0n,
  );
  const canCreate =
    kind !== 'approvals' &&
    me.actor.permissions.includes(
      kind === 'travel'
        ? 'travel.write.own'
        : kind === 'oa'
          ? 'oa.write.own'
          : 'expense.write.own',
    );
  return (
    <div className="business-page">
      <SectionTitle
        title={titles[kind]}
        description={
          kind === 'approvals'
            ? '查看当前指派给你的审批任务，按证据与版本作出决定。'
            : '草稿、详情和操作均保存到同一业务系统。'
        }
        actions={
          <>
            <button disabled={loading} onClick={() => void reload()}>
              刷新
            </button>
            {kind === 'expenses' && (
              <button onClick={() => setShowInvoices(true)}>管理票据</button>
            )}
            {canCreate && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() => void create()}
              >
                新建
                {kind === 'travel'
                  ? '差旅'
                  : kind === 'oa'
                    ? '前置申请'
                    : '报销'}
              </button>
            )}
          </>
        }
      />
      <ErrorNotice error={error} />
      {kind === 'approvals' && (
        <div className="action-strip">
          <p>
            {items.length} 项待处理
            <span className="money">
              当前列表合计 {formatMoney({ amount_minor: total.toString() })}
            </span>
          </p>
          <button
            className="primary-button"
            disabled={items.length === 0 || loading}
            onClick={() =>
              setPreauditRefs(
                items
                  .filter((item) => item.resource_ref.type === 'expense_claim')
                  .map((item) => item.resource_ref),
              )
            }
          >
            检查当前待审报销
          </button>
        </div>
      )}
      {loading ? (
        <p role="status" className="loading-line">
          正在读取单据…
        </p>
      ) : items.length === 0 ? (
        <Empty>
          当前范围内没有{kind === 'approvals' ? '待审任务' : '单据'}。
        </Empty>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>单据</th>
                <th>状态</th>
                <th>金额</th>
                <th>版本</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <button
                      className="document-link"
                      onClick={() => open(item)}
                    >
                      {item.title}
                    </button>
                    <small>{item.id}</small>
                  </td>
                  <td>
                    <Status value={item.state} />
                  </td>
                  <td className="money">
                    {formatMoney(
                      item.total_amount ?? item.total_budget ?? item.budget,
                    )}
                  </td>
                  <td>v{item.version}</td>
                  <td>
                    <button onClick={() => open(item)}>查看详情</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {document && (
        <BusinessDocumentDrawer
          kind={document.kind}
          id={document.id}
          me={me}
          onClose={close}
          onChanged={() => void reload()}
        />
      )}
      {showInvoices && (
        <Drawer
          title="票据与费用材料"
          subtitle="原始文件通过鉴权代理预览"
          onClose={() => setShowInvoices(false)}
          wide
        >
          <InvoicePanel onChanged={() => void reload()} />
        </Drawer>
      )}
      {preauditRefs && (
        <Drawer
          title="当前待审预审"
          subtitle="预审提供证据与风险分组，审批仍需你明确确认"
          onClose={() => setPreauditRefs(null)}
          wide
        >
          <PreauditPanel
            documents={preauditRefs}
            me={me}
            onOpen={(ref) => {
              setPreauditRefs(null);
              const item = items.find((value) => value.id === ref.id);
              if (item) open(item);
            }}
            onPrepare={async (intent) => {
              setReview(await prepareConfirmation(intent));
            }}
          />
        </Drawer>
      )}
      {review && (
        <ConfirmationPanel
          initial={review}
          actorName={me.display_name}
          onClose={() => setReview(null)}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}
