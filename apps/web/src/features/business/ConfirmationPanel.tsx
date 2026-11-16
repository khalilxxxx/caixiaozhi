import { useState } from 'react';
import type {
  InteractiveConfirmationReview,
  ActionView,
  ActionName,
} from '@caixiaozhi/contracts/actions';
import type { ResourceRef } from '@caixiaozhi/contracts/common';
import { api, ApiFailure, formatMoney, labels } from '../../api.js';
import { Drawer, ErrorNotice, Status } from '../../ui.js';
export type ActionIntent = {
  action: ActionName;
  resource_refs: ResourceRef[];
  args: unknown;
};
export async function prepareConfirmation(intent: ActionIntent) {
  const prepared = await api<{ confirmation_id: string }>('/confirmations', {
    method: 'POST',
    body: intent,
  });
  return api<InteractiveConfirmationReview>(
    `/confirmations/${prepared.confirmation_id}`,
  );
}
const operationLabels: Record<string, string> = {
  'travel.submit': '提交差旅',
  'travel.resubmit': '重新提交差旅',
  'travel.withdraw': '撤回差旅',
  'expense.submit': '提交报销',
  'expense.resubmit': '重新提交报销',
  'expense.withdraw': '撤回报销',
  'oa.submit': '提交前置申请',
  'oa.resubmit': '重新提交前置申请',
  'oa.withdraw': '撤回前置申请',
  'approval.approve': '批准当前单据',
  'approval.return': '退回补正',
  'approval.batch_approve': '批准选中的低风险单据',
  'rule.enable': '启用规则',
  'rule.publish': '发布公司规则',
  'rule.disable': '停用审核规则',
  'rule.mapping.publish': '发布字段映射',
  'skill.publish': '发布Skill',
  'oa.message.send': '发送演示站内通知',
  'policy.publish': '发布制度',
  'policy.withdraw': '撤回制度',
  'integration.capability.publish': '发布集成能力',
  'integration.capability.disable': '停用集成能力',
};
const summaryFields: Record<string, string> = {
  rule_name: '规则名称',
  mapping_name: '映射名称',
  provider: '来源提供方',
  module: '业务类型',
  draft_id: '草稿版本标识',
  draft_hash: '草稿校验值',
  test_run_id: '样例证明',
  runtime_binding: '来源接线',
  active_version: '当前生效内容版本',
  coverage_before: '停用前必查覆盖',
  coverage_after: '停用后必查覆盖',
  coverage_by_department: '各部门必查覆盖变化',
  policy_title: '制度名称',
  skill_title: '能力名称',
  version_number: '发布版本',
  scope: '生效范围',
  tools: '允许工具',
  effective_from: '生效日期',
  effective_to: '截止日期',
  level: '规则层级',
  category: '费用类别',
  dsl: '规则条件',
  dsl_json: '规则条件',
  source_citation_ids: '制度依据',
  department_ids: '适用部门',
  organization_ids: '适用组织',
  capability_name: '集成能力',
  version_id: '版本标识',
  reviewer_id: '审查人',
  impact: '影响范围',
  warning: '操作提示',
};
function Summary({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <p>请核对本次操作范围。</p>;
  const summary = value as Record<string, unknown>;
  const refs = (
    Array.isArray(summary.resource_refs)
      ? summary.resource_refs
      : summary.resource_ref
        ? [summary.resource_ref]
        : []
  ) as ResourceRef[];
  return (
    <div className="confirmation-summary">
      <dl>
        {typeof summary.action === 'string' && (
          <>
            <dt>本次操作</dt>
            <dd>{operationLabels[summary.action] ?? summary.action}</dd>
          </>
        )}
        {typeof summary.title === 'string' && (
          <>
            <dt>对象</dt>
            <dd>{summary.title}</dd>
          </>
        )}
        {typeof summary.count === 'number' && (
          <>
            <dt>数量</dt>
            <dd>{summary.count} 项</dd>
          </>
        )}
        {summary.total !== null &&
          typeof summary.total === 'object' &&
          'amount_minor' in summary.total && (
            <>
              <dt>金额</dt>
              <dd className="money">
                {formatMoney(summary.total as { amount_minor: string })}
              </dd>
            </>
          )}
        {typeof summary.reason === 'string' && summary.reason && (
          <>
            <dt>说明</dt>
            <dd>{summary.reason}</dd>
          </>
        )}
        {typeof summary.subject === 'string' && (
          <>
            <dt>消息主题</dt>
            <dd>{summary.subject}</dd>
          </>
        )}
        {Array.isArray(summary.recipient_ids) && (
          <>
            <dt>收件人</dt>
            <dd>{summary.recipient_ids.map(String).join('、')}</dd>
          </>
        )}
        {typeof summary.body === 'string' && (
          <>
            <dt>消息正文</dt>
            <dd className="preserve-lines">{summary.body}</dd>
          </>
        )}
        {Object.entries(summaryFields)
          .filter(
            ([key]) =>
              summary[key] !== undefined &&
              summary[key] !== null &&
              !(
                key === 'coverage_by_department' &&
                Array.isArray(summary[key]) &&
                summary[key].length === 0
              ),
          )
          .map(([key, label]) => (
            <div className="summary-detail" key={key}>
              <dt>{label}</dt>
              <dd className="preserve-lines">
                {key === 'runtime_binding'
                  ? summary[key] === 'live_demo'
                    ? '已接入本地演示业务投影'
                    : '仅人工样例验证，尚未接入真实来源'
                  : key === 'coverage_before' || key === 'coverage_after'
                    ? summary[key]
                      ? '完整覆盖'
                      : '未完整覆盖'
                    : key === 'coverage_by_department' &&
                        Array.isArray(summary[key])
                      ? (
                          summary[key] as Array<{
                            department_id: string;
                            before: boolean;
                            after: boolean;
                          }>
                        ).map((row) => (
                          <p key={row.department_id}>
                            {row.department_id}：
                            {row.before ? '完整覆盖' : '未完整覆盖'} →{' '}
                            {row.after ? '完整覆盖' : '未完整覆盖'}
                          </p>
                        ))
                      : typeof summary[key] === 'string' ||
                          typeof summary[key] === 'number'
                        ? String(summary[key])
                        : JSON.stringify(summary[key], null, 2)}
              </dd>
            </div>
          ))}
      </dl>
      {refs.length > 0 && (
        <section>
          <h3>确认对象与版本</h3>
          <ul className="resource-list">
            {refs.map((ref) => (
              <li key={`${ref.type}:${ref.id}`}>
                {ref.id}
                <span>v{ref.version}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted">范围或版本变化后需要重新准备确认。</p>
    </div>
  );
}
export function ConfirmationPanel({
  initial,
  actorName,
  onClose,
  onChanged,
}: {
  initial: InteractiveConfirmationReview;
  actorName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [review, setReview] = useState(initial),
    [result, setResult] = useState<ActionView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setReview(await api(`/confirmations/${review.confirmation_id}`));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (
        !review.confirmation_token ||
        !review.token_expires_at ||
        Date.parse(review.token_expires_at) <= Date.now()
      )
        throw new ApiFailure(
          'CONFIRMATION_EXPIRED',
          '确认凭据已过期，请刷新确认信息后重试。',
          409,
        );
      const action = await api<ActionView>(
        `/confirmations/${review.confirmation_id}/confirm`,
        {
          method: 'POST',
          body: {
            expected_version: review.version,
            summary_hash: review.summary_hash,
            confirmation_token: review.confirmation_token,
          },
        },
      );
      setResult(action);
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const current = await api<ActionView>(`/actions/${result.id}`);
      setResult(
        current.state === 'unknown'
          ? await api(`/actions/${current.id}/reconcile`, {
              method: 'POST',
              body: { expected_version: current.version },
            })
          : current,
      );
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const current = await api<ActionView>(`/actions/${review.action_id}`);
      setResult(
        await api(`/actions/${current.id}/cancel`, {
          method: 'POST',
          body: { expected_version: current.version },
        }),
      );
      onChanged();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const partial =
    result &&
    result.summary.succeeded > 0 &&
    result.summary.succeeded < result.items.length;
  return (
    <Drawer
      title={result ? '操作回执' : '确认本次操作'}
      subtitle={`当前身份 ${actorName}`}
      onClose={onClose}
    >
      <ErrorNotice error={error} />
      {result ? (
        <>
          <div className="result-heading">
            <h3>
              {result.state === 'unknown'
                ? '部分结果待核实'
                : partial
                  ? '部分完成'
                  : (labels[result.state] ?? result.state)}
            </h3>
            <p>每一项以下方业务回执为准。</p>
          </div>
          <ul className="receipt-list">
            {result.items.map((item) => (
              <li key={item.id}>
                <strong>{item.resource_ref?.id ?? '当前操作'}</strong>
                <Status value={item.receipt?.outcome ?? item.state} />
                {item.receipt?.resource && (
                  <small>当前版本 v{item.receipt.resource.version}</small>
                )}
                {item.receipt?.error_code && (
                  <span className="muted">{item.receipt.error_code}</span>
                )}
              </li>
            ))}
          </ul>
          <div className="button-row">
            {['unknown', 'executing', 'confirmed'].includes(result.state) && (
              <button disabled={busy} onClick={() => void reconcile()}>
                查询并核实原回执
              </button>
            )}
            <button className="primary-button" onClick={onClose}>
              返回
            </button>
          </div>
        </>
      ) : (
        <>
          <Summary value={review.summary} />
          <p className="muted">
            确认期限{' '}
            {new Date(review.expires_at).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}
          </p>
          <div className="drawer-actions">
            <button disabled={busy} onClick={() => void cancel()}>
              取消此动作
            </button>
            <button disabled={busy} onClick={() => void refresh()}>
              刷新确认信息
            </button>
            <button
              className="primary-button"
              disabled={busy || review.state !== 'prepared'}
              onClick={() => void confirm()}
            >
              {busy ? '正在处理…' : '确认并执行'}
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}
