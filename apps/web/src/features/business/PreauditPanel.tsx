import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type { ResourceRef } from '@caixiaozhi/contracts/common';
import type {
  PreauditResult,
  PreauditTaskAccepted,
  PreauditTaskView,
} from '@caixiaozhi/contracts/preaudit';
import type { ReviewerPurpose } from '@caixiaozhi/contracts/rules';
import { api, ApiFailure, formatMoney } from '../../api.js';
import { Empty, ErrorNotice, Field, Status } from '../../ui.js';
import type { ActionIntent } from './ConfirmationPanel.js';
const groupNames = {
  risk: '明确风险',
  incomplete: '材料待核',
  attention: '个人关注',
  low: '低风险',
};
export function PreauditPanel({
  documents,
  me,
  onPrepare,
  onOpen,
  onResult,
  purpose: initialPurpose,
}: {
  documents: ResourceRef[];
  me: Me;
  onPrepare?: (intent: ActionIntent) => Promise<void>;
  onOpen?: (ref: ResourceRef) => void;
  onResult?: (result: PreauditResult) => void;
  purpose?: ReviewerPurpose;
}) {
  const [purpose, setPurpose] = useState<ReviewerPurpose>(
    initialPurpose ??
      (me.actor.roles.includes('finance')
        ? 'finance_review'
        : me.actor.roles.includes('manager')
          ? 'manager_review'
          : 'employee_precheck'),
  );
  const [taskId, setTaskId] = useState<string | null>(null),
    [task, setTask] = useState<PreauditTaskView | null>(null),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [expanded, setExpanded] = useState<string | null>(null);
  const load = useCallback(
    async (id: string) => {
      const next = await api<PreauditTaskView>(`/preaudit/tasks/${id}`);
      setTask(next);
      if (next.items.length === 1 && next.items[0]?.result)
        onResult?.(next.items[0].result);
      return next;
    },
    [onResult],
  );
  useEffect(() => {
    if (!taskId || (task && !['queued', 'running'].includes(task.task.status)))
      return;
    let active = true;
    const timer = setTimeout(() => {
      void load(taskId).catch((failure) => {
        if (active) setError(failure);
      });
    }, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [taskId, task, load]);
  const start = async () => {
    setBusy(true);
    setError(null);
    setSelected(new Set());
    try {
      const accepted = await api<PreauditTaskAccepted>('/preaudit/tasks', {
        method: 'POST',
        body: { purpose, documents },
      });
      setTaskId(accepted.task_id);
      await load(accepted.task_id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (!taskId) return;
    setBusy(true);
    setError(null);
    try {
      await load(taskId);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const prepare = async () => {
    if (!task || !onPrepare) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await load(task.task.id);
      const chosen = fresh.items.filter((i) => selected.has(i.id));
      if (
        !chosen.length ||
        chosen.length > 50 ||
        chosen.some(
          (i) => !i.result?.eligible_for_bulk_approval || !i.result.task_ref,
        )
      )
        throw new ApiFailure(
          'REVALIDATION_REQUIRED',
          '所选结论已变化，请刷新后重新选择有效的低风险单据。',
          409,
        );
      await onPrepare({
        action: 'approval.batch_approve',
        resource_refs: chosen.map((i) => i.document_ref),
        args: {
          items: chosen.map((i) => ({
            resource_id: i.document_ref.id,
            task_ref: i.result!.task_ref,
            preaudit_result_id: i.result!.result_id,
          })),
        },
      });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!task) return;
    setBusy(true);
    try {
      await api(`/preaudit/tasks/${task.task.id}/cancel`, {
        method: 'POST',
        body: { expected_version: task.task.version },
      });
      await load(task.task.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="preaudit-panel">
      <p className="muted">
        本次明确选择 {documents.length}{' '}
        张单据。分组来自当前材料与已发布规则；低风险结论仍需人工确认审批。
      </p>
      <ErrorNotice error={error} />
      <div className="preaudit-controls">
        <Field label="检查用途">
          <select
            disabled={busy || !!initialPurpose}
            value={purpose}
            onChange={(event) =>
              setPurpose(event.target.value as ReviewerPurpose)
            }
          >
            <option value="employee_precheck">本人提交前预检</option>
            {me.actor.roles.includes('manager') && (
              <option value="manager_review">当前主管节点审核</option>
            )}
            {me.actor.roles.includes('finance') && (
              <option value="finance_review">当前财务节点审核</option>
            )}
          </select>
        </Field>
        <button
          className="primary-button"
          disabled={
            busy ||
            documents.length === 0 ||
            (!!task && ['queued', 'running'].includes(task.task.status))
          }
          onClick={() => void start()}
        >
          {busy ? '正在处理…' : task ? '按当前版本重新预审' : '开始本次预审'}
        </button>
        {task && (
          <button disabled={busy} onClick={() => void refresh()}>
            刷新状态
          </button>
        )}
        {task && ['queued', 'running'].includes(task.task.status) && (
          <button disabled={busy} onClick={() => void cancel()}>
            停止未执行检查
          </button>
        )}
      </div>
      {documents.length === 0 && (
        <Empty>没有可预审的已授权单据，请先选择当前业务对象。</Empty>
      )}
      {task && (
        <>
          <div className="task-progress" role="status">
            <Status value={task.task.status} />
            <span>
              已完成 {task.counts.completed + task.counts.stale}/
              {task.task.total}
            </span>
            {task.counts.failed > 0 && (
              <span>{task.counts.failed} 项读取或执行失败</span>
            )}
            <span className="money">
              检查金额 {formatMoney(task.summary.total_amount)}
            </span>
          </div>
          <div className="preaudit-groups">
            {Object.entries(groupNames).map(([group, label]) => {
              const summary =
                task.summary.groups[group as keyof typeof groupNames];
              return (
                <div key={group}>
                  <strong>{label}</strong>
                  <span>{summary.count} 张</span>
                  <span className="money">{formatMoney(summary.amount)}</span>
                </div>
              );
            })}
          </div>
          <ul className="preaudit-items">
            {task.items.map((item) => {
              const result = item.result;
              return (
                <li key={item.id}>
                  <div className="preaudit-row">
                    {onPrepare && purpose !== 'employee_precheck' && (
                      <input
                        type="checkbox"
                        aria-label={`选择${item.document_ref.id}低风险结论`}
                        disabled={!result?.eligible_for_bulk_approval || busy}
                        checked={selected.has(item.id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <button
                      className="document-link"
                      onClick={() =>
                        setExpanded(expanded === item.id ? null : item.id)
                      }
                    >
                      {item.document_ref.id}
                    </button>
                    <Status
                      value={
                        result?.status === 'stale'
                          ? 'stale'
                          : (result?.group ?? item.status)
                      }
                    />
                    <span className="money">{formatMoney(result?.amount)}</span>
                    {onOpen && (
                      <button onClick={() => onOpen(item.document_ref)}>
                        打开单据
                      </button>
                    )}
                  </div>
                  {item.last_error && (
                    <p className="error-text">{item.last_error.message}</p>
                  )}
                  {item.skipped_reason && (
                    <p className="muted">本项已停止，尚未完成检查。</p>
                  )}
                  {expanded === item.id && result && (
                    <div className="preaudit-detail">
                      <p>
                        公司适用必查 {result.coverage.company_known_total}/
                        {result.coverage.company_required_total}，另{' '}
                        {result.coverage.company_not_applicable_total}{' '}
                        项明确不适用；个人检查{' '}
                        {result.coverage.personal_known_total}/
                        {result.coverage.personal_selected_total}。
                      </p>
                      {result.coverage.company_unknown_total +
                        result.coverage.personal_unknown_total >
                        0 && (
                        <p className="error-text">
                          存在无法判断的必要字段，不能作为低风险候选。
                        </p>
                      )}
                      {result.findings.length === 0 ? (
                        <p>当前已配置的适用检查未发现异常。</p>
                      ) : (
                        <ul>
                          {result.findings.map((finding) => (
                            <li key={finding.id}>
                              <strong>{finding.message}</strong>
                              {finding.field_refs.length > 0 && (
                                <small>
                                  字段：{finding.field_refs.join('、')}
                                </small>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="muted">
                        检查时刻{' '}
                        {new Date(result.snapshot_at).toLocaleString('zh-CN')} ·
                        单据 v{result.document_ref.version}
                        {result.status === 'stale'
                          ? ' · 结论已失效，请重新预审。'
                          : ''}
                      </p>
                      {purpose === 'employee_precheck' && (
                        <p>
                          提交前预检，不具备审批资格；提交后需要按正式版本重新检查。
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {onPrepare && purpose !== 'employee_precheck' && (
            <div className="button-row">
              <p>已明确选择 {selected.size} 项（每次最多50项）</p>
              <button
                className="primary-button"
                disabled={busy || selected.size === 0 || selected.size > 50}
                onClick={() => void prepare()}
              >
                核对并准备所选项批准
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
