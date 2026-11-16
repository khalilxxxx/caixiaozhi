import { useEffect, useState } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import type {
  QueryPlan,
  MetricDefinition,
  AnalysisFact,
} from '@caixiaozhi/contracts/analytics';
import { api, formatMoney } from '../../api.js';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  SectionTitle,
  Status,
} from '../../ui.js';
type Snapshot = {
  id: string;
  version: number;
  metric: string;
  total: { amount_minor: string; currency: 'CNY' } | { count: number };
  comparison: {
    base: { amount_minor: string };
    delta: { amount_minor: string };
    rate_percent: string | null;
    reason: string | null;
  } | null;
  rows: Array<{
    dimension_key: string;
    label: string;
    value: string;
    fact_refs: string[];
  }>;
  quality: string;
  quality_notes: string[];
  snapshot_at: string;
  scope_label: string;
  period_label: string;
  freshness: 'fresh' | 'stale';
  query_plan: QueryPlan;
};
type RequestView = {
  id: string;
  status: string;
  snapshot_id: string | null;
  job_id: string;
  error_code: string | null;
};
type Report = {
  id: string;
  version: number;
  state: string;
  editable_blocks: {
    title?: string;
    narrative?: string;
    recommendations?: string;
    user_note?: string;
  };
  snapshot: Snapshot;
};
type Artifact = {
  id: string;
  state: string;
  downloadable: boolean;
  format: string;
  size_bytes: number | null;
};
const metricNames: Record<string, string> = {
  'expense.completed_amount': '审批完成金额',
  'expense.completed_count': '审批完成单数',
  'expense.submitted_amount': '最新有效提交金额',
  'expense.pending_manager_amount': '当前主管待审金额',
  'expense.pending_manager_count': '当前主管待审单数',
  'expense.low_candidate_amount': '有效低风险候选金额',
  'expense.low_candidate_count': '有效低风险候选单数',
  'expense.entertainment_completed_amount': '已完成招待费用',
  'expense.category_completed_amount': '已完成费用分类',
};
const dimensionNames: Record<string, string> = {
  applicant: '申请人',
  department: '部门',
  expense_type: '费用类型',
  completed_day: '完成日期',
  completed_month: '完成月份',
  submitted_day: '提交日期',
  submitted_month: '提交月份',
};
export function AnalyticsWorkspace({ me }: { me: Me }) {
  const [catalog, setCatalog] = useState<MetricDefinition[]>([]),
    [metric, setMetric] = useState('expense.completed_amount'),
    [from, setFrom] = useState('2026-11-01'),
    [to, setTo] = useState('2026-11-06'),
    [dimension, setDimension] = useState('applicant'),
    [compare, setCompare] = useState(true);
  const departmentIds = [
    ...new Set(
      me.grants
        .filter(
          (g) =>
            g.capability === 'analytics.query' && g.scope_type === 'department',
        )
        .flatMap((g) => g.scope_ids),
    ),
  ];
  const [scope, setScope] = useState(
      departmentIds.length ? 'department' : 'self',
    ),
    [selectedDepartments, setSelectedDepartments] = useState(departmentIds);
  const [request, setRequest] = useState<RequestView | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [rows, setRows] = useState<AnalysisFact[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selectedGroup, setSelectedGroup] = useState<string | undefined>(),
    [drawer, setDrawer] = useState(false),
    [report, setReport] = useState<Report | null>(null),
    [artifact, setArtifact] = useState<Artifact | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [prose, setProse] = useState<Report['editable_blocks']>({}),
    [notice, setNotice] = useState('');
  const permitted = me.actor.permissions.includes('analytics.query'),
    definition = catalog.find((m) => m.metric_id === metric),
    stock = definition?.date_basis === 'snapshot_at';
  useEffect(() => {
    if (!permitted) return;
    const abort = new AbortController();
    void api<{ metrics: MetricDefinition[] }>('/analytics/catalog', {
      signal: abort.signal,
    })
      .then((v) => setCatalog(v.metrics))
      .catch((e) => {
        if (!abort.signal.aborted) setError(e);
      });
    const old = new URLSearchParams(location.search).get('analysis_request');
    if (old)
      void api<RequestView>(`/analytics/queries/${old}`, {
        signal: abort.signal,
      })
        .then(setRequest)
        .catch((e) => {
          if (!abort.signal.aborted) setError(e);
        });
    return () => abort.abort();
  }, [permitted]);
  useEffect(() => {
    if (!request || !['queued', 'running'].includes(request.status)) return;
    let live = true;
    const timer = setTimeout(() => {
      void api<RequestView>(`/analytics/queries/${request.id}`)
        .then((v) => {
          if (live) setRequest(v);
        })
        .catch((e) => {
          if (live) setError(e);
        });
    }, 1200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [request]);
  useEffect(() => {
    if (!request?.snapshot_id) return;
    let live = true;
    void api<Snapshot>(`/analytics/snapshots/${request.snapshot_id}`)
      .then((v) => {
        if (live) {
          setSnapshot(v);
          setNotice('分析已完成，图表与明细使用同一冻结快照。');
        }
      })
      .catch((e) => {
        if (live) setError(e);
      });
    return () => {
      live = false;
    };
  }, [request?.snapshot_id]);
  useEffect(() => {
    if (!artifact || !['queued', 'running'].includes(artifact.state)) return;
    let live = true;
    const timer = setTimeout(() => {
      void api<Artifact>(`/analytics/artifacts/${artifact.id}`)
        .then((v) => {
          if (live) setArtifact(v);
        })
        .catch((e) => {
          if (live) setError(e);
        });
    }, 1200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [artifact]);
  useEffect(() => {
    if (!report || report.state === 'ready') return;
    let live = true;
    const timer = setTimeout(() => {
      void api<Report>(`/analytics/reports/${report.id}`)
        .then((v) => {
          if (live) setReport(v);
        })
        .catch((e) => {
          if (live) setError(e);
        });
    }, 1200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [report]);
  const loadRows = async (id: string, group?: string, next?: string) => {
    const p = new URLSearchParams({ limit: '20' });
    if (group) p.set('dimension_key', group);
    if (next) p.set('cursor', next);
    const data = await api<{
      items: AnalysisFact[];
      next_cursor: string | null;
    }>(`/analytics/snapshots/${id}/rows?${p}`);
    setRows((previous) => (next ? [...previous, ...data.items] : data.items));
    setCursor(data.next_cursor);
    setSelectedGroup(group);
  };
  const submit = async () => {
    if (!definition) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const plan = {
        metric,
        period: stock
          ? {
              as_of: 'current',
              timezone: 'Asia/Shanghai',
              date_basis: 'snapshot_at',
            }
          : {
              from,
              to_exclusive: to,
              timezone: 'Asia/Shanghai',
              date_basis: definition.date_basis,
              ...(compare
                ? {
                    compare_to: {
                      from: '2026-10-01',
                      to_exclusive: '2026-11-01',
                    },
                  }
                : {}),
            },
        dimensions: dimension ? [dimension] : [],
        filters: {
          scope,
          ...(scope === 'self' ? {} : { department_ids: selectedDepartments }),
        },
      };
      const result = await api<{
        request_id: string;
        job_id: string;
        status: string;
      }>('/analytics/queries', { method: 'POST', body: plan });
      setRequest({
        id: result.request_id,
        status: result.status,
        snapshot_id: null,
        job_id: result.job_id,
        error_code: null,
      });
      setSnapshot(null);
      setReport(null);
      setArtifact(null);
      const url = new URL(location.href);
      url.searchParams.set('analysis_request', result.request_id);
      history.replaceState(null, '', url);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const openDetail = async (group?: string) => {
    if (!snapshot) return;
    setError(null);
    try {
      await loadRows(snapshot.id, group);
      setDrawer(true);
      const url = new URL(location.href);
      url.searchParams.set('drawer', 'analytics');
      url.searchParams.set('resource', snapshot.id);
      history.replaceState(null, '', url);
    } catch (e) {
      setError(e);
    }
  };
  const makeReport = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ report_id: string }>('/analytics/reports', {
        method: 'POST',
        body: {
          analysis_snapshot_id: snapshot.id,
          template: 'monthly_expense',
        },
      });
      const value = await api<Report>(
        `/analytics/reports/${created.report_id}`,
      );
      setReport(value);
      setProse(value.editable_blocks);
      setDrawer(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const saveReport = async () => {
    if (!report) return;
    setBusy(true);
    try {
      await api(`/analytics/reports/${report.id}/draft`, {
        method: 'PATCH',
        body: { expected_version: report.version, editable_blocks: prose },
      });
      setReport(await api(`/analytics/reports/${report.id}`));
      setNotice('报告说明已保存，事实数字保持原快照。');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async (format: 'csv' | 'html') => {
    if (!report) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api<{ artifact_id: string }>(
        `/analytics/reports/${report.id}/exports`,
        {
          method: 'POST',
          body: {
            expected_version: report.version,
            format,
            freshness_choice: 'as_recorded',
          },
        },
      );
      setArtifact(await api(`/analytics/artifacts/${value.artifact_id}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!permitted)
    return (
      <>
        <SectionTitle title="费用分析" description="按审批事实看清费用变化。" />
        <Empty>当前身份没有费用分析授权。切换身份后会重新读取可见范围。</Empty>
      </>
    );
  return (
    <>
      <SectionTitle
        title="费用分析"
        description="金额来自业务记录，完成口径表示审批完成。"
      />
      <ErrorNotice error={error} />
      <form
        className="finance-query"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="finance-query-fields">
          <Field label="分析内容">
            <select
              value={metric}
              onChange={(e) => {
                setMetric(e.target.value);
                setDimension('applicant');
              }}
            >
              {catalog.map((m) => (
                <option key={m.metric_id} value={m.metric_id}>
                  {metricNames[m.metric_id]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="统计范围">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="self">本人</option>
              {departmentIds.length > 0 && (
                <option value="department">授权部门</option>
              )}
            </select>
          </Field>
          <Field label="分组">
            <select
              value={dimension}
              onChange={(e) => setDimension(e.target.value)}
            >
              <option value="">不分组</option>
              {definition?.allowed_dimensions.map((d) => (
                <option key={d} value={d}>
                  {dimensionNames[d]}
                </option>
              ))}
            </select>
          </Field>
          {!stock && (
            <>
              <Field label="开始日期">
                <input
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="结束日期（不含）">
                <input
                  type="date"
                  required
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        {scope !== 'self' && (
          <fieldset className="finance-inline-choices">
            <legend>选择已授权部门</legend>
            {departmentIds.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={selectedDepartments.includes(id)}
                  onChange={(e) =>
                    setSelectedDepartments((v) =>
                      e.target.checked ? [...v, id] : v.filter((x) => x !== id),
                    )
                  }
                />
                {id === me.department_id ? me.department_name : id}
              </label>
            ))}
          </fieldset>
        )}
        <div className="finance-query-footer">
          {!stock && (
            <label className="finance-check">
              <input
                type="checkbox"
                checked={compare}
                onChange={(e) => setCompare(e.target.checked)}
              />
              对比 10 月完整月份
            </label>
          )}
          {stock && (
            <p className="muted">当前时点存量，不按历史完成日期筛选。</p>
          )}
          <button
            className="primary-button"
            disabled={
              busy ||
              !definition ||
              (scope !== 'self' && !selectedDepartments.length)
            }
          >
            {busy ? '正在提交…' : '生成分析'}
          </button>
        </div>
      </form>
      <div className="finance-live" role="status" aria-live="polite">
        {notice}
        {request && ['queued', 'running'].includes(request.status) && (
          <>
            分析任务
            <Status value={request.status} />
            可留在当前页等待，刷新后可恢复。
          </>
        )}
        {request?.status === 'failed' && (
          <>查询未完成。请检查权限、预审依赖或数据服务后重新生成。</>
        )}
      </div>
      {snapshot ? (
        <section className="finance-analysis">
          <header className="finance-result-header">
            <div>
              <h2>{metricNames[snapshot.metric] ?? '分析结果'}</h2>
              <p>
                {snapshot.scope_label} · {snapshot.period_label}
              </p>
            </div>
            <span className={`finance-freshness ${snapshot.freshness}`}>
              {snapshot.freshness === 'fresh'
                ? '冻结快照'
                : '历史快照 · 源数据已更新'}
            </span>
          </header>
          <div className="finance-total">
            <span>
              {'amount_minor' in snapshot.total
                ? formatMoney(snapshot.total)
                : `${snapshot.total.count} 张`}
            </span>
            {snapshot.comparison && (
              <p>
                对比 {formatMoney(snapshot.comparison.base)}，变化{' '}
                {formatMoney(snapshot.comparison.delta)}
                {snapshot.comparison.rate_percent === null
                  ? '；基期为零，不计算增幅'
                  : `（${snapshot.comparison.rate_percent}%）`}
              </p>
            )}
          </div>
          {snapshot.quality === 'empty' ? (
            <Empty>当前授权范围与口径内没有匹配记录。</Empty>
          ) : (
            <div className="finance-chart" aria-label="分析分组图表">
              {snapshot.rows.map((row) => {
                const max = snapshot.rows.reduce(
                    (v, r) => (BigInt(r.value) > v ? BigInt(r.value) : v),
                    0n,
                  ),
                  width =
                    max > 0n
                      ? Number((BigInt(row.value) * 10000n) / max) / 100
                      : 0;
                return (
                  <button
                    className="finance-chart-row"
                    key={row.dimension_key}
                    onClick={() => void openDetail(row.dimension_key)}
                  >
                    <span>{row.label}</span>
                    <span className="finance-bar-track">
                      <span style={{ width: `${width}%` }} />
                    </span>
                    <strong>
                      {'amount_minor' in snapshot.total
                        ? formatMoney({ amount_minor: row.value })
                        : `${row.value} 张`}
                    </strong>
                  </button>
                );
              })}
            </div>
          )}
          {snapshot.quality_notes.length > 0 && (
            <div className="finance-quality">
              <strong>数据质量说明</strong>
              <ul>
                {snapshot.quality_notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <footer className="finance-result-footer">
            <small>
              截至 {new Date(snapshot.snapshot_at).toLocaleString('zh-CN')} ·
              图表与明细同一快照
            </small>
            <div className="button-row">
              <button onClick={() => void openDetail()}>查看明细</button>
              <button disabled={busy} onClick={() => void makeReport()}>
                生成私有报告
              </button>
              {snapshot.freshness === 'stale' && (
                <button onClick={() => void submit()}>重新生成最新分析</button>
              )}
            </div>
          </footer>
        </section>
      ) : (
        !request && (
          <Empty>
            选择指标与范围后生成分析。图表、明细和报告将引用同一份事实。
          </Empty>
        )
      )}
      {drawer && snapshot && (
        <Drawer
          title={report ? '费用报告草稿' : '分析明细'}
          subtitle={`${snapshot.scope_label} · ${snapshot.period_label}`}
          onClose={() => {
            setDrawer(false);
            setReport(null);
            const url = new URL(location.href);
            url.searchParams.delete('drawer');
            url.searchParams.delete('resource');
            history.replaceState(null, '', url);
          }}
          wide
        >
          <ErrorNotice error={error} />
          {report ? (
            <>
              <p className="finance-note">
                报告仅本人可见。金额与表格由快照锁定，修改说明不会改变统计事实。
              </p>
              <Field label="报告标题">
                <input
                  value={prose.title ?? ''}
                  onChange={(e) =>
                    setProse((v) => ({ ...v, title: e.target.value }))
                  }
                />
              </Field>
              <Field label="摘要说明">
                <textarea
                  rows={4}
                  value={prose.narrative ?? ''}
                  onChange={(e) =>
                    setProse((v) => ({ ...v, narrative: e.target.value }))
                  }
                />
              </Field>
              <Field label="行动建议">
                <textarea
                  rows={3}
                  value={prose.recommendations ?? ''}
                  onChange={(e) =>
                    setProse((v) => ({ ...v, recommendations: e.target.value }))
                  }
                />
              </Field>
              <Field label="用户补充（未经业务数据验证）">
                <textarea
                  rows={3}
                  value={prose.user_note ?? ''}
                  onChange={(e) =>
                    setProse((v) => ({ ...v, user_note: e.target.value }))
                  }
                />
              </Field>
              <div className="finance-locked-fact">
                <span>锁定事实 · {metricNames[snapshot.metric]}</span>
                <strong>
                  {'amount_minor' in snapshot.total
                    ? formatMoney(snapshot.total)
                    : `${snapshot.total.count} 张`}
                </strong>
                <small>{snapshot.period_label}</small>
              </div>
              <div className="button-row">
                <button
                  disabled={busy}
                  className="primary-button"
                  onClick={() => void saveReport()}
                >
                  保存说明
                </button>
                {me.actor.permissions.includes('analytics.export') && (
                  <>
                    <button
                      disabled={busy || report.state !== 'ready'}
                      onClick={() => void exportFile('csv')}
                    >
                      导出 CSV 明细
                    </button>
                    <button
                      disabled={busy || report.state !== 'ready'}
                      onClick={() => void exportFile('html')}
                    >
                      导出 HTML 报告
                    </button>
                  </>
                )}
              </div>
              {snapshot.freshness === 'stale' && (
                <p className="finance-note">
                  本次导出保留历史快照，并在文件中标明源数据已更新。
                </p>
              )}
              {artifact && (
                <div className="finance-artifact" role="status">
                  <Status value={artifact.state} />
                  {artifact.downloadable ? (
                    <a
                      href={`/api/v1/analytics/artifacts/${artifact.id}/download`}
                    >
                      下载 {artifact.format.toUpperCase()} ·{' '}
                      {artifact.size_bytes ?? 0} 字节
                    </a>
                  ) : (
                    <p>文件完成后将在此显示下载入口。</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="finance-note">
                这里显示创建分析时冻结的事实。当前单据的后续更改不会替换这些数字。
              </p>
              <div className="finance-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>单据</th>
                      <th>申请人</th>
                      <th>版本</th>
                      <th>金额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.claim_ref.id}</td>
                        <td>{row.applicant_id}</td>
                        <td>v{row.claim_ref.version}</td>
                        <td className="money">
                          {formatMoney({ amount_minor: row.amount_minor })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {cursor && (
                <button
                  onClick={() =>
                    void loadRows(snapshot.id, selectedGroup, cursor)
                  }
                >
                  继续加载
                </button>
              )}
            </>
          )}
        </Drawer>
      )}
    </>
  );
}
