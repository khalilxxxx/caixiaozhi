import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Me } from '@caixiaozhi/contracts/identity';
import {
  DemoFaultKindSchema,
  type DemoFaultKind,
} from '@caixiaozhi/contracts/demo';
import { StartDemoJourneySchema } from '@caixiaozhi/contracts/demo-scenarios';
import { api, labels } from '../../api.js';
import { Drawer, Empty, ErrorNotice, Field, SectionTitle } from '../../ui.js';
import './operations.css';

type Environment = {
  id: string;
  active_tenant_id: string;
  generation: number;
  version: number;
  lifecycle: string;
  seed_version: string;
  manifest_hash: string | null;
  business_now: string;
  timezone: string;
  clock_version: number;
};
type Manifest = {
  manifest: {
    assertions: Array<{ name: string; passed: boolean }>;
    alias_map: Record<string, string>;
  };
};
type ResetJob = {
  id: string;
  state: string;
  phase: string;
  error_code: string | null;
  new_generation: number;
};
type Scenario = { id: string; title: string };
type ScenarioRun = {
  id: string;
  scenario_id: string;
  state: string;
  generation: number;
  baseline_generation?: number | null;
  outcome?: string | null;
  error_code?: string | null;
  evidence?: Array<{
    step_id: string;
    passed: boolean;
    trace_id: string;
    resource_refs: Array<{ type: string; id: string; version: number }>;
    occurred_at: string;
  }>;
};
type Fault = {
  id: string;
  kind: DemoFaultKind;
  scope_alias: string;
  remaining_hits: number;
  expires_at: string;
  state: string;
  version: number;
  generation: number;
};
type SummaryTrigger = {
  request_id: string;
  job_id: string;
  status: string;
  result?: { enqueued: number } | null;
  error_code?: string | null;
};
type Run = {
  id: string;
  owner_id: string;
  status: string;
  phase: string | null;
  origin: string;
  runtime_active: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempt: number;
  trace_id: string;
  error_code: string | null;
  usage: {
    model_calls: number;
    tool_calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    elapsed_ms: number;
  };
  budgets: {
    model_calls: number;
    tool_calls: number;
    output_tokens: number;
    active_ms: number;
  };
};
type Timeline = {
  run: { id: string; status: string; trace_id: string };
  events: Array<{ seq: number; type: string; occurred_at: string }>;
  tools: Array<{
    call_id: string;
    name: string;
    effect: string;
    status: string;
    duration_ms: number | null;
    error_code: string | null;
    action_id: string | null;
    created_at: string;
  }>;
};
type Jobs = {
  items: Array<{
    id: string;
    kind: string;
    status: string;
    attempt: number;
    generation: number;
    lease_epoch: number;
    lease_until: string | null;
    error_code: string | null;
    created_at: string;
  }>;
  model_slots: Array<{ kind: string; active: number }>;
  limits: { per_user: number; per_tenant: number };
};
type ReconciliationItem = {
  action_id: string;
  operation: string;
  state: string;
  trace_id: string;
  pending_items: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  manual_required: boolean;
};
const faultNames: Record<DemoFaultKind, string> = {
  'ocr.timeout': '票据识别超时',
  'ocr.low_confidence': '票据识别低置信度',
  'preaudit.check_unavailable': '预审核验暂不可用',
  'action.response_lost_after_commit': '业务提交成功后丢失回包',
  'adapter.write_outcome_unknown': '外部写入结果待核实',
  'maas.read_unavailable': '能力读取暂不可用',
  'sse.disconnect_once': '流式连接断开一次',
  'worker.interrupt_once': 'Worker 检查点中断一次',
};
const stateNames: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  ready: '已就绪',
  draining: '停止接单中',
  resetting: '重建中',
  verifying: '验证中',
  blocked: '等待核实',
  passed: '已通过',
  failed: '失败',
  succeeded: '已完成',
  cancelled: '已停止',
  armed: '已启用',
  exhausted: '次数已用完',
  expired: '已到期',
  disabled: '已停用',
  scheduled: '已安排生成',
  no_due_subscription: '没有到期日程',
  waiting_confirmation: '等待本人确认',
  waiting_user: '等待补充',
  interrupted: '已中断',
  reconciling: '核实回执中',
};
const phaseNames: Record<string, string> = {
  stop_admission: '停止新任务',
  reconcile_receipts: '核实在途回执',
  build_fixtures: '构建基准数据',
  verify_fixtures: '验证完整性',
  activate: '切换新代',
  waiting_domain_job: '等待领域作业',
  pending_receipts: '核实写入回执',
  readonly_recovery: '恢复只读任务',
  waiting_model_slot: '等待模型执行名额',
  pending_input: '处理补充输入',
};
const eventNames: Record<string, string> = {
  'run.created': '创建运行',
  'run.state': '运行状态更新',
  'assistant.delta': '接收回复增量',
  'assistant.message': '保存最终回复',
  'tool.started': '开始工具调用',
  'tool.completed': '工具调用完成',
  'confirmation.required': '请求本人确认',
  'card.upsert': '更新结果卡',
  'usage.updated': '更新用量',
  'run.cancel_requested': '请求停止',
};
const assertionNames: Record<string, string> = {
  users_7: '七名演示身份',
  claims_11: '十一张基准报销',
  initial_versions_1: '基准对象版本',
  sales_pending_5: '销售部五张待审',
  sales_pending_554000: '销售待审合计 5,540 元',
  sales_completed_590000: '销售本月已批 5,900 元',
  clm004_known_amount_unknown_verification: '第四张单据金额明确、核验待定',
};
const displayState = (value: string) =>
  stateNames[value] ?? labels[value] ?? value;
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('zh-CN') : '—';
const duration = (value: number) => `${(value / 1000).toFixed(1)} 秒`;
function State({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>{displayState(value)}</span>
  );
}
function remember(env: string, key: string, id: string) {
  try {
    sessionStorage.setItem(`demo-control:${env}:${key}`, id);
  } catch {
    /* 仅缓存控制任务引用，状态仍由服务器读取。 */
  }
}
function recall(env: string, key: string) {
  try {
    return sessionStorage.getItem(`demo-control:${env}:${key}`);
  } catch {
    return null;
  }
}
function usePoll<T>(
  path: string | null,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
) {
  useEffect(() => {
    if (!path) return;
    let active = true;
    const controller = new AbortController();
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (active) onValue(value);
      } catch (error) {
        if (active) onError(error);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 1500);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [path, onValue, onError]);
}

export function OperationsPage({ me }: { me: Me }) {
  const canDemo = me.actor.permissions.includes('demo.control'),
    canOperate = me.actor.permissions.includes('operations.read');
  const [tab, setTab] = useState(canDemo ? 'demo' : 'runtime'),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [success, setSuccess] = useState('');
  const [environment, setEnvironment] = useState<Environment | null>(null),
    [status, setStatus] = useState<{
      dsh: {
        sdk_version: string;
        profile_version: string;
        model_configured: boolean;
      };
    } | null>(null),
    [manifest, setManifest] = useState<Manifest | null>(null),
    [scenarios, setScenarios] = useState<Scenario[]>([]),
    [faults, setFaults] = useState<Fault[]>([]),
    [job, setJob] = useState<ResetJob | null>(null),
    [clock, setClock] = useState('');
  const [showReset, setShowReset] = useState(false),
    [reviewScenario, setReviewScenario] = useState<Scenario | null>(null),
    [scenarioRun, setScenarioRun] = useState<ScenarioRun | null>(null),
    [scenarioLookup, setScenarioLookup] = useState(''),
    [showEvidence, setShowEvidence] = useState(false),
    [summary, setSummary] = useState<SummaryTrigger | null>(null);
  const [showFault, setShowFault] = useState(false),
    [faultKind, setFaultKind] = useState<DemoFaultKind>('ocr.timeout'),
    [faultAlias, setFaultAlias] = useState(''),
    [hits, setHits] = useState(1),
    [ttl, setTtl] = useState(5);
  const [runs, setRuns] = useState<Run[]>([]),
    [reconciliations, setReconciliations] = useState<ReconciliationItem[]>([]),
    [jobs, setJobs] = useState<Jobs | null>(null),
    [runStatus, setRunStatus] = useState(''),
    [runOwner, setRunOwner] = useState(''),
    [timeline, setTimeline] = useState<Timeline | null>(null),
    [timelineBusy, setTimelineBusy] = useState(false);
  const loadRuns = useCallback(async (statusFilter = '', owner = '') => {
    const query = new URLSearchParams({ limit: '30' });
    if (statusFilter) query.set('status', statusFilter);
    if (owner.trim()) query.set('user_id', owner.trim());
    const result = await api<{ items: Run[] }>(`/operations/runs?${query}`);
    setRuns(result.items);
  }, []);
  const load = useCallback(async () => {
    setError(null);
    const tasks: Promise<unknown>[] = [];
    if (canDemo) {
      tasks.push(
        api<Environment>('/demo/environments/current').then((value) => {
          setEnvironment(value);
          setClock(value.business_now);
          const scenarioId = recall(value.id, 'scenario');
          if (scenarioId) {
            setScenarioLookup(scenarioId);
            void api<ScenarioRun>(
              `/demo/scenario-runs/${encodeURIComponent(scenarioId)}`,
            )
              .then(setScenarioRun)
              .catch(setError);
          }
          const resetId = recall(value.id, 'reset');
          if (resetId)
            void api<ResetJob>(
              `/demo/reset-jobs/${encodeURIComponent(resetId)}`,
            )
              .then(setJob)
              .catch(setError);
        }),
      );
      tasks.push(
        api<Manifest>('/demo/manifest').then((value) => {
          setManifest(value);
          setFaultAlias(
            (current) =>
              current || Object.keys(value.manifest.alias_map).sort()[0] || '',
          );
        }),
      );
      tasks.push(
        api<{ items: Scenario[] }>('/demo/scenarios').then((value) =>
          setScenarios(
            value.items.filter((item) => /^E2E-\d\d$/.test(item.id)),
          ),
        ),
      );
      tasks.push(
        api<{ items: Fault[] }>('/demo/faults').then((value) =>
          setFaults(value.items),
        ),
      );
    }
    if (canOperate) {
      tasks.push(api<typeof status>('/operations/status').then(setStatus));
      tasks.push(loadRuns());
      tasks.push(api<Jobs>('/operations/jobs').then(setJobs));
      tasks.push(
        api<{ items: ReconciliationItem[] }>(
          '/operations/actions/reconciliation',
        ).then((value) => setReconciliations(value.items)),
      );
    }
    const results = await Promise.allSettled(tasks);
    for (const result of results)
      if (result.status === 'rejected') setError(result.reason);
    setLoading(false);
  }, [canDemo, canOperate, loadRuns]);
  useEffect(() => {
    void load();
  }, [load]);
  usePoll<ResetJob>(
    job && !['succeeded', 'failed', 'blocked'].includes(job.state)
      ? `/demo/reset-jobs/${job.id}`
      : null,
    setJob,
    setError,
  );
  usePoll<ScenarioRun>(
    scenarioRun && ['queued', 'running'].includes(scenarioRun.state)
      ? `/demo/scenario-runs/${scenarioRun.id}`
      : null,
    setScenarioRun,
    setError,
  );
  usePoll<SummaryTrigger>(
    summary && ['queued', 'running'].includes(summary.status)
      ? `/demo/summary-triggers/${summary.request_id}`
      : null,
    setSummary,
    setError,
  );
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setSuccess('');
    try {
      await work();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const guard = () => {
    if (!environment) throw new Error('请先读取当前演示环境。');
    return {
      expected_generation: environment.generation,
      expected_environment_version: environment.version,
    };
  };
  const reset = () =>
    perform(async () => {
      if (!environment) return;
      const value = await api<ResetJob>('/demo/reset', {
        method: 'POST',
        body: {
          ...guard(),
          seed_version: 'finance-agent-v1.0',
          scenario_id: 'baseline',
          intent: 'reset_demo_environment',
        },
      });
      setJob(value);
      remember(environment.id, 'reset', value.id);
      setShowReset(false);
      setSuccess('重建请求已入队。环境切换后请重新选择演示身份。');
    });
  const saveClock = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      if (!environment) return;
      if (!Number.isFinite(Date.parse(clock)))
        throw new Error('业务时刻格式无效，请填写包含时区的 ISO 时间。');
      const value = await api<Environment>('/demo/business-clock', {
        method: 'PUT',
        body: {
          ...guard(),
          expected_version: environment.clock_version,
          business_now: new Date(clock).toISOString(),
          timezone: environment.timezone,
        },
      });
      setEnvironment(value);
      setClock(value.business_now);
      setSuccess('业务时刻已更新。');
    });
  };
  const startScenario = () =>
    perform(async () => {
      if (!environment || !reviewScenario) return;
      const value = await api<ScenarioRun>(
        `/demo/scenarios/${reviewScenario.id}/start`,
        {
          method: 'POST',
          body: StartDemoJourneySchema.parse({
            ...guard(),
            intent: 'run_isolated_demo_journey',
          }),
        },
      );
      setScenarioRun(value);
      setScenarioLookup(value.id);
      remember(environment.id, 'scenario', value.id);
      setReviewScenario(null);
      setSuccess(
        '隔离旅程已入队。当前会话失效后，重新选择管理员即可查看此场景记录。',
      );
    });
  const armFault = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const value = await api<Fault>('/demo/faults', {
        method: 'POST',
        body: {
          ...guard(),
          kind: faultKind,
          scope_alias: faultAlias,
          hits,
          ttl_minutes: ttl,
        },
      });
      setFaults((current) => [value, ...current]);
      setShowFault(false);
      setSuccess('故障已启用，将按指定范围、次数和真实期限生效。');
    });
  };
  const disableFault = (fault: Fault) =>
    perform(async () => {
      const value = await api<Fault>(`/demo/faults/${fault.id}/disable`, {
        method: 'POST',
        body: { ...guard(), expected_version: fault.version },
      });
      setFaults((current) =>
        current.map((item) => (item.id === value.id ? value : item)),
      );
      setSuccess('已停止后续注入，原有失败或待核实结果保持原状态。');
    });
  const openTimeline = async (run: Run) => {
    setTimelineBusy(true);
    setError(null);
    try {
      setTimeline(await api<Timeline>(`/operations/runs/${run.id}/timeline`));
    } catch (failure) {
      setError(failure);
    } finally {
      setTimelineBusy(false);
    }
  };
  const aliases = Object.keys(manifest?.manifest.alias_map ?? {}).sort(),
    ready = environment?.lifecycle === 'ready';
  return (
    <div className="operations-page">
      <SectionTitle
        title="运行与演示"
        description="查看当前租户的任务元数据，控制合成演示环境。"
        actions={
          <button disabled={busy || loading} onClick={() => void load()}>
            {loading ? '正在读取…' : '刷新状态'}
          </button>
        }
      />
      <div
        className="operations-tabs"
        role="tablist"
        aria-label="运行与演示视图"
      >
        {canDemo && (
          <button
            role="tab"
            aria-selected={tab === 'demo'}
            onClick={() => setTab('demo')}
          >
            演示控制
          </button>
        )}
        {canOperate && (
          <button
            role="tab"
            aria-selected={tab === 'runtime'}
            onClick={() => setTab('runtime')}
          >
            任务运维
          </button>
        )}
      </div>
      <ErrorNotice error={error} />
      {success && (
        <p className="operations-success" role="status">
          {success}
        </p>
      )}
      {loading && (
        <p className="loading-line" role="status">
          正在读取真实环境与运行记录…
        </p>
      )}
      {tab === 'demo' && canDemo && (
        <>
          <section
            className="surface-section"
            aria-labelledby="environment-title"
          >
            <div className="operations-section-heading">
              <h2 id="environment-title">环境状态</h2>
              <span className="environment-pill">合成演示数据</span>
            </div>
            {environment ? (
              <>
                <dl className="detail-list">
                  <dt>当前状态</dt>
                  <dd>
                    <State value={environment.lifecycle} />
                  </dd>
                  <dt>当前代</dt>
                  <dd>第 {environment.generation} 代</dd>
                  <dt>种子版本</dt>
                  <dd>{environment.seed_version}</dd>
                  <dt>清单校验值</dt>
                  <dd>{environment.manifest_hash ?? '尚未验证'}</dd>
                  <dt>业务时区</dt>
                  <dd>{environment.timezone}</dd>
                </dl>
                <button
                  className="danger-button"
                  disabled={busy || !ready}
                  onClick={() => setShowReset(true)}
                >
                  重建基准环境
                </button>
                {manifest && (
                  <details className="operations-evidence">
                    <summary>查看基准完整性证据</summary>
                    <ul className="evidence-list">
                      {manifest.manifest.assertions.map((assertion) => (
                        <li key={assertion.name}>
                          <span>
                            {assertionNames[assertion.name] ?? assertion.name}
                          </span>
                          <State
                            value={assertion.passed ? 'passed' : 'failed'}
                          />
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              !loading && <Empty>环境读取失败，请刷新状态后重试。</Empty>
            )}
            {job && (
              <div className="operations-job">
                <h3>环境重建任务</h3>
                <p>
                  <State value={job.state} /> ·{' '}
                  {phaseNames[job.phase] ?? job.phase} · 目标第{' '}
                  {job.new_generation} 代
                </p>
                <p className="operations-reference">任务标识 {job.id}</p>
                {job.error_code && (
                  <p role="alert">
                    {job.error_code === 'OUTCOME_UNKNOWN'
                      ? '仍有原动作结果待核实，请先核实原回执。'
                      : `重建未完成：${job.error_code}`}
                  </p>
                )}
                {job.state === 'blocked' && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const env = await api<Environment>(
                          '/demo/environments/current',
                        );
                        setEnvironment(env);
                        await api(`/demo/reset-jobs/${job.id}/resume`, {
                          method: 'POST',
                          body: {
                            expected_generation: env.generation,
                            expected_environment_version: env.version,
                          },
                        });
                        setJob({ ...job, state: 'queued' });
                      })
                    }
                  >
                    核实后继续原重建任务
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="surface-section" aria-labelledby="scenario-title">
            <h2 id="scenario-title">场景选择</h2>
            <p className="muted">
              每条旅程先重建独立的一代基准数据，再执行正式业务流程。成功与否以实际步骤证据为准。
            </p>
            <div className="operations-scenarios">
              {scenarios.map((scenario) => (
                <article key={scenario.id}>
                  <div>
                    <h3>{scenario.title}</h3>
                    <small>{scenario.id}</small>
                  </div>
                  <button
                    disabled={busy || !ready}
                    onClick={() => setReviewScenario(scenario)}
                  >
                    审阅并运行
                  </button>
                </article>
              ))}
            </div>
            {!loading && scenarios.length === 0 && (
              <Empty>暂无可运行场景，请刷新状态检查服务。</Empty>
            )}
            <form
              className="operations-lookup"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const value = await api<ScenarioRun>(
                    `/demo/scenario-runs/${encodeURIComponent(scenarioLookup.trim())}`,
                  );
                  setScenarioRun(value);
                  if (environment)
                    remember(environment.id, 'scenario', value.id);
                });
              }}
            >
              <Field label="场景任务标识">
                <input
                  value={scenarioLookup}
                  onChange={(event) => setScenarioLookup(event.target.value)}
                  placeholder="重新登录后可查询原任务"
                />
              </Field>
              <button disabled={busy || !scenarioLookup.trim()}>
                查看场景记录
              </button>
            </form>
            {scenarioRun && (
              <div className="operations-job">
                <div className="operations-section-heading">
                  <h3>{scenarioRun.scenario_id} 执行记录</h3>
                  <State value={scenarioRun.state} />
                </div>
                <p className="operations-reference">
                  任务标识 {scenarioRun.id}
                </p>
                <p>
                  开始于第 {scenarioRun.generation} 代
                  {scenarioRun.baseline_generation
                    ? `，基准为第 ${scenarioRun.baseline_generation} 代`
                    : ''}
                  。
                </p>
                {scenarioRun.outcome && (
                  <p>实际结果：{displayState(scenarioRun.outcome)}</p>
                )}
                {scenarioRun.error_code && (
                  <p role="alert">执行未完成：{scenarioRun.error_code}</p>
                )}
                <button onClick={() => setShowEvidence(true)}>
                  查看步骤证据
                </button>
              </div>
            )}
          </section>
          <section className="surface-section" aria-labelledby="clock-title">
            <h2 id="clock-title">业务时钟与摘要</h2>
            <form onSubmit={saveClock}>
              <Field
                label="业务时刻（ISO，带时区）"
                hint="仅改变业务日期和日程；确认期限、租约和审计继续使用真实 UTC。"
              >
                <input
                  required
                  value={clock}
                  onChange={(event) => setClock(event.target.value)}
                />
              </Field>
              <div className="button-row">
                <button disabled={busy || !ready}>更新业务时刻</button>
                <button
                  type="button"
                  disabled={busy || !ready}
                  onClick={() =>
                    void perform(async () => {
                      setSummary(
                        await api<SummaryTrigger>('/demo/summary-triggers', {
                          method: 'POST',
                          body: guard(),
                        }),
                      );
                    })
                  }
                >
                  触发到期摘要
                </button>
              </div>
            </form>
            <p className="muted">
              仅调度本环境已启用且到期的日程。结果进入订阅者本人的收件箱。
            </p>
            {summary && (
              <div className="operations-job">
                <p>
                  <State value={summary.status} />
                  {summary.result && ` · 入队 ${summary.result.enqueued} 条`}
                </p>
                <p className="operations-reference">
                  请求标识 {summary.request_id}
                </p>
                {summary.error_code && (
                  <p role="alert">摘要调度未完成：{summary.error_code}</p>
                )}
              </div>
            )}
          </section>
          <section className="surface-section" aria-labelledby="fault-title">
            <div className="operations-section-heading">
              <h2 id="fault-title">故障与恢复</h2>
              <button
                disabled={busy || !ready || aliases.length === 0}
                onClick={() => setShowFault(true)}
              >
                配置演示故障
              </button>
            </div>
            <p className="muted">
              故障仅在选定对象、次数和真实期限内生效。停止注入后，已有待核实动作仍按原回执核实。
            </p>
            {faults.length ? (
              <div className="operations-records">
                {faults.map((fault) => (
                  <article key={fault.id} data-fault-id={fault.id}>
                    <div>
                      <h3>{faultNames[fault.kind]}</h3>
                      <p>
                        范围 {fault.scope_alias} · 剩余 {fault.remaining_hits}{' '}
                        次 · 到期 {date(fault.expires_at)}
                      </p>
                      <State value={fault.state} />
                    </div>
                    {fault.state === 'armed' && (
                      <button
                        disabled={busy}
                        onClick={() => void disableFault(fault)}
                      >
                        停止后续注入
                      </button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              !loading && <Empty>当前没有故障配置。</Empty>
            )}
          </section>
        </>
      )}
      {tab === 'runtime' && canOperate && (
        <>
          <section className="surface-section">
            <h2>Agent 运行环境</h2>
            {status && (
              <dl className="detail-list">
                <dt>dsh SDK</dt>
                <dd>{status.dsh.sdk_version}</dd>
                <dt>受控 Profile</dt>
                <dd>{status.dsh.profile_version}</dd>
                <dt>真实模型</dt>
                <dd>
                  {status.dsh.model_configured
                    ? '已配置，实际调用结果以运行记录为准'
                    : '未配置，Agent 任务将明确失败'}
                </dd>
              </dl>
            )}
            {jobs && (
              <p>
                当前租户模型执行占用{' '}
                {jobs.model_slots.reduce(
                  (total, item) => total + item.active,
                  0,
                )}{' '}
                个；每用户上限 {jobs.limits.per_user} 个，租户上限{' '}
                {jobs.limits.per_tenant} 个。
              </p>
            )}
            <a href="/status">查看数据库与私有文件存储状态</a>
          </section>
          <section className="surface-section" aria-labelledby="runs-title">
            <h2 id="runs-title">Agent 运行记录</h2>
            <p className="muted">
              当前租户运行元数据，不含会话正文、工具参数和结果原文。
            </p>
            <form
              className="operations-filters"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(() => loadRuns(runStatus, runOwner));
              }}
            >
              <Field label="运行状态">
                <select
                  value={runStatus}
                  onChange={(event) => setRunStatus(event.target.value)}
                >
                  <option value="">全部状态</option>
                  {[
                    'queued',
                    'running',
                    'waiting_confirmation',
                    'waiting_user',
                    'interrupted',
                    'reconciling',
                    'succeeded',
                    'failed',
                    'cancelled',
                  ].map((value) => (
                    <option key={value} value={value}>
                      {displayState(value)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="用户标识">
                <input
                  value={runOwner}
                  onChange={(event) => setRunOwner(event.target.value)}
                  placeholder="例如 u-li"
                />
              </Field>
              <button disabled={busy}>查询运行记录</button>
            </form>
            {runs.length ? (
              <div className="table-scroll">
                <table className="data-table operations-table">
                  <thead>
                    <tr>
                      <th>运行 / 用户</th>
                      <th>状态 / 阶段</th>
                      <th>创建时间</th>
                      <th>调用 / 用量</th>
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <span className="operations-reference">{run.id}</span>
                          <small>
                            {run.owner_id} ·{' '}
                            {run.origin === 'subscription'
                              ? '订阅摘要'
                              : '会话任务'}
                          </small>
                        </td>
                        <td>
                          <State value={run.status} />
                          <small>
                            {run.phase
                              ? (phaseNames[run.phase] ?? run.phase)
                              : '—'}
                          </small>
                          {run.error_code && <small>{run.error_code}</small>}
                        </td>
                        <td>
                          {date(run.created_at)}
                          <small>
                            活动 {duration(run.usage.elapsed_ms)} · 第{' '}
                            {run.attempt} 次领取
                          </small>
                        </td>
                        <td>
                          模型 {run.usage.model_calls}/{run.budgets.model_calls}{' '}
                          · 工具 {run.usage.tool_calls}/{run.budgets.tool_calls}
                          <small>
                            输入 {run.usage.input_tokens} · 输出{' '}
                            {run.usage.output_tokens} tokens
                          </small>
                        </td>
                        <td>
                          <button
                            disabled={timelineBusy}
                            aria-label={`查看运行 ${run.id}`}
                            onClick={() => void openTimeline(run)}
                          >
                            查看时间线
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              !loading && <Empty>没有符合条件的运行记录。</Empty>
            )}
          </section>
          <section className="surface-section">
            <h2>待核实动作</h2>
            <p className="muted">
              后台只查询原动作的回执。超过十五分钟仍未知时需人工联系原系统核查，请保留动作标识与追踪标识。
            </p>
            {reconciliations.length ? (
              <div className="table-scroll">
                <table className="data-table operations-table">
                  <thead>
                    <tr>
                      <th>动作 / 操作</th>
                      <th>待核实项</th>
                      <th>最近查询</th>
                      <th>处理状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliations.map((item) => (
                      <tr key={item.action_id}>
                        <td>
                          <span className="operations-reference">
                            {item.action_id}
                          </span>
                          <small>{item.operation}</small>
                          <small>追踪 {item.trace_id}</small>
                        </td>
                        <td>{item.pending_items}</td>
                        <td>
                          {item.last_attempt_at
                            ? date(item.last_attempt_at)
                            : '等待首次核实'}
                        </td>
                        <td>
                          {item.manual_required
                            ? '需要人工核查，后台仍会继续查询'
                            : '后台按退避计划查询'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              !loading && <Empty>当前没有待核实动作。</Empty>
            )}
          </section>
          <section className="surface-section">
            <h2>领域作业与租约</h2>
            <p className="muted">
              显示最近一百条持久作业；普通领域作业不占模型执行名额。
            </p>
            {jobs?.items.length ? (
              <div className="table-scroll">
                <table className="data-table operations-table">
                  <thead>
                    <tr>
                      <th>作业 / 类型</th>
                      <th>状态</th>
                      <th>尝试 / 代次</th>
                      <th>租约</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <span className="operations-reference">
                            {item.id}
                          </span>
                          <small>{item.kind}</small>
                        </td>
                        <td>
                          <State value={item.status} />
                          {item.error_code && <small>{item.error_code}</small>}
                        </td>
                        <td>
                          {item.attempt} 次 · 第 {item.generation} 代
                        </td>
                        <td>
                          epoch {item.lease_epoch}
                          <small>
                            {item.lease_until
                              ? `到期 ${date(item.lease_until)}`
                              : '当前无租约'}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              !loading && <Empty>当前没有领域作业记录。</Empty>
            )}
          </section>
        </>
      )}
      {showReset && environment && (
        <Drawer
          title="确认重建演示环境"
          subtitle={`操作身份 ${me.display_name}`}
          onClose={() => setShowReset(false)}
        >
          <p>
            将停止第 {environment.generation}{' '}
            代的新业务，核实在途动作后，在独立命名空间建立完整基准数据。旧代数据保留审计，当前会话会失效。
          </p>
          <p>
            基准包含七名身份、十一张报销及合成制度、规则和票据。存在未知写入时，重建会停在核实阶段。
          </p>
          <ErrorNotice error={error} />
          <div className="drawer-actions">
            <button onClick={() => setShowReset(false)}>暂不重建</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void reset()}
            >
              确认重建基准环境
            </button>
          </div>
        </Drawer>
      )}
      {reviewScenario && environment && (
        <Drawer
          title="确认运行隔离旅程"
          subtitle={`${reviewScenario.id} · ${reviewScenario.title}`}
          onClose={() => setReviewScenario(null)}
        >
          <p>
            将先重建当前演示环境，从第 {environment.generation}{' '}
            代切换至新的完整基准，再通过正式接口执行此旅程。
          </p>
          <ul className="operations-impact">
            <li>本环境其他演示身份的旧会话、待确认操作和后台任务会失效。</li>
            <li>旧代业务与审计保留；已经成功的业务动作不会被声称撤销。</li>
            <li>
              未知写入会阻止重建；真实模型未配置或流程失败时，场景将如实记录失败。
            </li>
          </ul>
          <p>重新选择管理员后，可在此页查看原场景任务与逐步证据。</p>
          <ErrorNotice error={error} />
          <div className="drawer-actions">
            <button onClick={() => setReviewScenario(null)}>暂不运行</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => void startScenario()}
            >
              确认重建并运行旅程
            </button>
          </div>
        </Drawer>
      )}
      {showFault && (
        <Drawer
          title="配置演示故障"
          subtitle="仅作用于当前合成演示环境"
          onClose={() => setShowFault(false)}
        >
          <form onSubmit={armFault}>
            <Field label="故障类型">
              <select
                value={faultKind}
                onChange={(event) =>
                  setFaultKind(DemoFaultKindSchema.parse(event.target.value))
                }
              >
                {DemoFaultKindSchema.options.map((kind) => (
                  <option key={kind} value={kind}>
                    {faultNames[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="演示对象范围" hint="只能选择当前已验证清单中的对象。">
              <select
                required
                value={faultAlias}
                onChange={(event) => setFaultAlias(event.target.value)}
              >
                {aliases.map((alias) => (
                  <option key={alias} value={alias}>
                    {alias}
                  </option>
                ))}
              </select>
            </Field>
            <div className="operations-form-pair">
              <Field label="生效次数">
                <input
                  type="number"
                  required
                  min={1}
                  max={10}
                  value={hits}
                  onChange={(event) => setHits(Number(event.target.value))}
                />
              </Field>
              <Field label="有效期（分钟）">
                <input
                  type="number"
                  required
                  min={1}
                  max={30}
                  value={ttl}
                  onChange={(event) => setTtl(Number(event.target.value))}
                />
              </Field>
            </div>
            <p className="muted">
              期限按真实 UTC
              计算。停止注入不会改写已经产生的失败、未知结果或回执。
            </p>
            <ErrorNotice error={error} />
            <div className="drawer-actions">
              <button type="button" onClick={() => setShowFault(false)}>
                取消
              </button>
              <button className="primary-button" disabled={busy || !faultAlias}>
                启用此故障
              </button>
            </div>
          </form>
        </Drawer>
      )}
      {showEvidence && scenarioRun && (
        <Drawer
          title="场景步骤证据"
          subtitle={`${scenarioRun.scenario_id} · ${scenarioRun.id}`}
          onClose={() => setShowEvidence(false)}
        >
          {scenarioRun.evidence?.length ? (
            <ol className="operations-timeline">
              {scenarioRun.evidence.map((item, index) => (
                <li key={`${item.step_id}:${index}`}>
                  <div className="operations-section-heading">
                    <strong>{item.step_id}</strong>
                    <State value={item.passed ? 'passed' : 'failed'} />
                  </div>
                  <small>{date(item.occurred_at)}</small>
                  <p className="operations-reference">trace {item.trace_id}</p>
                  {item.resource_refs.map((ref) => (
                    <p
                      className="operations-reference"
                      key={`${ref.type}:${ref.id}`}
                    >
                      {ref.type} · {ref.id} · v{ref.version}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          ) : (
            <Empty>
              尚无已完成步骤证据，当前状态为{displayState(scenarioRun.state)}。
            </Empty>
          )}
        </Drawer>
      )}
      {timeline && (
        <Drawer
          title="运行时间线"
          subtitle={timeline.run.id}
          onClose={() => setTimeline(null)}
          wide
        >
          <dl className="detail-list">
            <dt>当前状态</dt>
            <dd>
              <State value={timeline.run.status} />
            </dd>
            <dt>追踪标识</dt>
            <dd>{timeline.run.trace_id}</dd>
          </dl>
          <h3>状态与事件</h3>
          {timeline.events.length ? (
            <ol className="operations-timeline">
              {timeline.events.map((event) => (
                <li key={event.seq}>
                  <strong>{eventNames[event.type] ?? event.type}</strong>
                  <small>
                    序号 {event.seq} · {date(event.occurred_at)}
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>尚无持久事件。</Empty>
          )}
          <h3>工具调用元数据</h3>
          {timeline.tools.length ? (
            <ul className="operations-timeline">
              {timeline.tools.map((tool) => (
                <li key={tool.call_id}>
                  <div className="operations-section-heading">
                    <strong>{tool.name}</strong>
                    <State value={tool.status} />
                  </div>
                  <small>
                    {tool.effect === 'read'
                      ? '只读'
                      : tool.effect === 'propose'
                        ? '准备建议'
                        : '业务写入'}{' '}
                    ·{' '}
                    {tool.duration_ms === null
                      ? '尚无耗时'
                      : duration(tool.duration_ms)}
                  </small>
                  <p className="operations-reference">
                    调用标识 {tool.call_id}
                  </p>
                  {tool.action_id && (
                    <p className="operations-reference">
                      动作标识 {tool.action_id}
                    </p>
                  )}
                  {tool.error_code && <p>{tool.error_code}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <Empty>此运行尚无工具调用记录。</Empty>
          )}
        </Drawer>
      )}
    </div>
  );
}
