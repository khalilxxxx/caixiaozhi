import { useEffect, useRef } from 'react';
import type { ToolStep } from './run-progress-model';
import { Icon } from './ui';
import './run-progress.css';

interface RunProgressProps {
  steps?: ToolStep[];
  running: boolean;
  status?: string;
  activity?: string;
  phase?: string;
  onStop?: () => void;
}

const actionIcons = {
  reading: 'file',
  searching: 'search',
  calculating: 'chart',
  writing: 'edit',
  checking: 'shield',
  working: 'settings',
  waiting: 'chat',
} as const;
type ActionKind = keyof typeof actionIcons | 'thinking';

const tools: Record<string, readonly [ActionKind, string]> = {
  ask_user: ['waiting', '确认办理信息'],
  query_documents: ['searching', '查询单据'],
  analyze_expenses: ['calculating', '分析费用'],
  create_expense_report: ['writing', '生成费用报告'],
  query_business_board: ['calculating', '查询业务看板'],
  create_analysis_report: ['writing', '生成可视化报告'],
  read_business_report: ['reading', '读取分析报告'],
  query_public_financials: ['searching', '查询公开财报'],
  create_public_financial_report: ['writing', '生成公开财报报告'],
  read_public_financial_report: ['reading', '读取公开财报报告'],
  search_policies: ['searching', '查询制度'],
  get_submission_draft: ['reading', '读取单据草稿'],
  update_submission_draft: ['writing', '更新单据草稿'],
  new_submission_draft: ['writing', '创建单据草稿'],
  validate_submission: ['checking', '检查单据'],
  list_reimbursable_travel_applications: ['searching', '查询可报销差旅申请'],
  link_travel_application: ['writing', '关联差旅申请'],
  preaudit_documents: ['checking', '预审单据'],
  list_materials: ['reading', '查看材料'],
  read_uploaded_file: ['reading', '读取文件'],
  extract_expense_materials: ['reading', '提取费用材料'],
  summarize_expense_csv: ['calculating', '汇总费用'],
  read_expense_summary: ['reading', '读取费用汇总'],
  get_submission_receipt: ['searching', '查询办理回执'],
  read_current_rules: ['reading', '读取规则'],
  prepare_personal_rule: ['writing', '整理个人规则'],
  list_available_skills: ['searching', '查找可用技能'],
  get_skill_instructions: ['reading', '读取技能说明'],
  list_skill_files: ['searching', '查找技能文件'],
  read_skill_file: ['reading', '读取技能文件'],
  write_skill_file: ['writing', '写入技能文件'],
  run_skill_command: ['working', '执行技能'],
  run_skill_script: ['working', '执行技能脚本'],
  validate_skill_artifact: ['checking', '核对技能成果'],
  publish_skill_artifact: ['writing', '交付成果'],
};

function toolInfo(name: string) {
  return Object.hasOwn(tools, name) ? tools[name] : undefined;
}

function stepLabel(step: ToolStep) {
  return step.label?.trim() || toolInfo(step.name)?.[1] || '处理任务';
}

function currentKind(active: ToolStep | undefined, phase?: string): ActionKind {
  if (phase === 'awaiting_input') return 'waiting';
  if (active) return toolInfo(active.name)?.[0] ?? 'working';
  if (phase === 'thinking' || phase === 'checking') return phase;
  return phase === 'responding' ? 'writing' : 'working';
}

function ActivityIcon({ kind }: { kind: ActionKind }) {
  return (
    <span className="run-progress-activity-icon" aria-hidden="true">
      {kind === 'thinking' ? (
        <svg
          viewBox="0 0 28 26"
          width="24"
          height="23"
          fill="none"
          focusable="false"
        >
          <path
            d="m5.5 10 1-7 5.6 4h3.8l5.6-4 1 7"
            fill="#eff7fc"
            stroke="#7da6c5"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <rect
            x="3.5"
            y="7.7"
            width="20"
            height="14"
            rx="6.5"
            fill="#244665"
            stroke="#b7d8ed"
            strokeWidth="1.2"
          />
          <path
            d="M10.2 12.3v3.1m6.7-3.1v3.1"
            stroke="#a2eef1"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M2 17.5c.6 4.8 8.3 6.3 15.8 4.1 5.9-1.8 9.4-5.1 8.2-7.7"
            stroke="#82a3bf"
            strokeLinecap="round"
          />
          <path
            className="run-progress-orbit-light"
            d="M2 17.5c.6 4.8 8.3 6.3 15.8 4.1 5.9-1.8 9.4-5.1 8.2-7.7"
            pathLength="100"
            stroke="#3198dd"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <Icon name={actionIcons[kind]} size={18} />
      )}
    </span>
  );
}

function timestamp(value: ToolStep['startedAt']) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stepDuration(step: ToolStep) {
  if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs))
    return Math.max(0, step.durationMs);
  const start = timestamp(step.startedAt);
  const end = timestamp(step.finishedAt);
  return start !== null && end !== null ? Math.max(0, end - start) : null;
}

function durationText(duration: number) {
  if (duration > 0 && duration < 100) return '不足 0.1 秒';
  if (duration < 60000)
    return `${Number((duration / 1000).toFixed(duration < 10000 ? 1 : 0))} 秒`;
  const seconds = Math.floor(duration / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runState(
  status: string | undefined,
  running: boolean,
  steps: ToolStep[],
) {
  if (running) return 'running';
  if (['awaiting_input', 'waiting', '待你回答'].includes(status ?? ''))
    return 'waiting';
  if (['paused', '已暂停'].includes(status ?? '')) return 'paused';
  if (['cancelled', 'canceled', '已停止'].includes(status ?? ''))
    return 'cancelled';
  if (
    ['failed', 'interrupted', 'incomplete', '未完成', '处理失败'].includes(
      status ?? '',
    )
  )
    return 'failed';
  if (['completed', 'succeeded'].includes(status ?? '')) return 'completed';
  if (steps.some((step) => step.status === 'failed')) return 'failed';
  if (steps.some((step) => step.status === 'cancelled')) return 'cancelled';
  if (steps.some((step) => step.status === 'running')) return 'incomplete';
  return 'record';
}

const stateLabels: Record<string, string> = {
  completed: '已完成',
  failed: '未完成',
  incomplete: '未完成',
  cancelled: '已停止',
  paused: '已暂停',
  waiting: '待你回答',
  record: '执行记录',
};

function StatusIcon({ state }: { state: string }) {
  return (
    <span className={`run-progress-icon is-${state}`} aria-hidden="true">
      {state === 'running' ? (
        <i />
      ) : (
        <Icon
          name={
            state === 'completed'
              ? 'check'
              : state === 'failed' || state === 'incomplete'
                ? 'alert'
                : state === 'cancelled' || state === 'paused'
                  ? 'stop'
                  : 'clock'
          }
          size={12}
        />
      )}
    </span>
  );
}

export function RunProgress({
  steps = [],
  running,
  status,
  activity,
  phase,
  onStop,
}: RunProgressProps) {
  const progress = useRef<HTMLDivElement>(null);
  const state = runState(status, running, steps);
  const active = running
    ? steps.filter((step) => step.status === 'running').at(-1)
    : undefined;
  const waiting = phase === 'awaiting_input';
  const kind = currentKind(active, phase);
  const animate = running && kind !== 'waiting';
  const currentAction = waiting
    ? activity?.trim() || '待你回答'
    : active
      ? stepLabel(active)
      : activity?.trim() ||
        (phase === 'thinking'
          ? '正在思考'
          : phase === 'responding'
            ? '正在整理回复'
            : '正在处理');
  const label = running ? currentAction : stateLabels[state];
  const completed = steps.filter((step) => step.status === 'completed').length;
  const itinerary = steps.filter((step) => step.itinerary).at(-1)?.itinerary;

  useEffect(() => {
    const element = progress.current;
    const row = element?.querySelector('.run-progress-summary');
    if (!animate || !element || !row) return;
    let inView = true;
    const syncMotion = () => {
      element.dataset.motionPaused = String(document.hidden || !inView);
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver(([entry]) => {
            if (!entry) return;
            inView = entry.isIntersecting;
            syncMotion();
          });
    syncMotion();
    observer?.observe(row);
    document.addEventListener('visibilitychange', syncMotion);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', syncMotion);
      delete element.dataset.motionPaused;
    };
  }, [animate]);

  if (!steps.length && !running) return null;

  return (
    <div ref={progress} className={`run-progress is-${state}`}>
      <span
        className="run-progress-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {label}
      </span>
      {running && (
        <div className="run-progress-summary" data-activity={kind}>
          <ActivityIcon kind={kind} />
          <span className="run-progress-label">
            {label}
            {animate && (
              <span
                aria-hidden="true"
                className="run-progress-glint"
                data-label={label}
              />
            )}
          </span>
          {onStop && (
            <button
              className="run-progress-stop"
              type="button"
              onClick={onStop}
            >
              <Icon name="stop" size={12} />
              停止办理
            </button>
          )}
        </div>
      )}
      {steps.length > 0 && (
        <details
          className="run-progress-details"
          open={running}
          key={running ? 'live' : 'history'}
        >
          <summary className="run-progress-toggle">
            <Icon name="chevron" size={13} className="run-progress-chevron" />
            {!running && state !== 'record' && (
              <>
                <StatusIcon state={state} />
                <span>{label}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>执行记录</span>
            <span className="run-progress-count">
              {running
                ? `${completed}/${steps.length} 项已完成`
                : `${steps.length} 个步骤`}
            </span>
          </summary>
          <ol className="run-progress-steps" aria-label="本轮执行步骤">
            {steps.map((step, index) => {
              const stepState =
                step.status === 'running' && !running
                  ? 'incomplete'
                  : step.status;
              const elapsed =
                stepState === 'running' ? null : stepDuration(step);
              const statusLabel =
                stepState === 'running'
                  ? '执行中'
                  : stepState === 'completed'
                    ? '已完成'
                    : stepState === 'failed'
                      ? '未成功'
                      : stepState === 'cancelled'
                        ? '已取消'
                        : '未完成';
              return (
                <li
                  className={`run-progress-step is-${stepState}`}
                  key={step.id || `step-${index}`}
                >
                  <StatusIcon state={stepState} />
                  <span className="run-progress-step-label">
                    <span>步骤 {index + 1}：</span>
                    {stepLabel(step)}
                    {step.expertSkill && step.expertConnector && (
                      <small className="run-expert-source">{step.expertSkill} · {step.expertConnector}</small>
                    )}
                  </span>
                  <span className="run-progress-step-meta">
                    <span
                      className={
                        stepState === 'completed' && elapsed !== null
                          ? 'run-progress-announcement'
                          : 'run-progress-step-status'
                      }
                    >
                      {statusLabel}
                    </span>
                    {elapsed !== null && (
                      <span className="run-progress-duration">
                        {durationText(elapsed)}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          {(itinerary?.destination || itinerary?.transport) && (
            <dl className="run-progress-context">
              {itinerary.destination && (
                <div>
                  <dt>目的地</dt>
                  <dd>{itinerary.destination}</dd>
                </div>
              )}
              {itinerary.transport && (
                <div>
                  <dt>交通方式</dt>
                  <dd>{itinerary.transport}</dd>
                </div>
              )}
            </dl>
          )}
        </details>
      )}
    </div>
  );
}
