import { useEffect, useRef, useState } from 'react';
import type { ToolStep } from './run-progress-model';
import { Icon } from './ui';
import './run-progress.css';

interface RunProgressProps {
  steps?: ToolStep[];
  running: boolean;
  status?: string;
  activity?: string;
  phase?: string;
}

const toolLabels: Record<string, string> = {
  ask_user: '确认办理信息',
  query_documents: '查询单据',
  analyze_expenses: '分析费用',
  create_expense_report: '生成费用报告',
  search_policies: '查询制度',
  get_submission_draft: '读取单据草稿',
  update_submission_draft: '更新单据草稿',
  new_submission_draft: '创建单据草稿',
  validate_submission: '检查单据',
  preaudit_documents: '预审单据',
  list_materials: '查看材料',
  read_uploaded_file: '读取文件',
  extract_expense_materials: '提取费用材料',
  summarize_expense_csv: '汇总费用',
  read_expense_summary: '读取费用汇总',
  get_submission_receipt: '查询办理回执',
  read_current_rules: '读取规则',
  prepare_personal_rule: '整理个人规则',
  list_available_skills: '查找可用技能',
  read_skill_file: '读取技能文件',
  run_skill_command: '执行技能',
  publish_skill_artifact: '交付成果',
};

function stepLabel(step: ToolStep) {
  return step.label?.trim() || toolLabels[step.name] || '处理任务';
}

function timestamp(value: ToolStep['startedAt']) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stepDuration(step: ToolStep, now?: number) {
  if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs))
    return Math.max(0, step.durationMs);
  const start = timestamp(step.startedAt);
  const end = timestamp(step.finishedAt) ?? now;
  return start !== null && end !== undefined && end !== null
    ? Math.max(0, end - start)
    : null;
}

function durationText(duration: number) {
  if (duration < 1000) return '不足 1 秒';
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
        size={14}
      />
    </span>
  );
}

export function RunProgress({
  steps = [],
  running,
  status,
  activity,
  phase,
}: RunProgressProps) {
  const details = useRef<HTMLDetailsElement>(null);
  const [now, setNow] = useState(Date.now);
  const state = runState(status, running, steps);
  const active = running
    ? steps.filter((step) => step.status === 'running').at(-1)
    : undefined;
  const currentAction = active
    ? stepLabel(active)
    : activity?.trim() ||
      (phase === 'responding' ? '正在整理回复' : '正在处理');
  const label = running ? currentAction : stateLabels[state];

  useEffect(() => {
    if (!running && details.current) details.current.open = false;
  }, [running]);

  useEffect(() => {
    if (!running || !active?.startedAt) return;
    const tick = () => {
      if (!document.hidden) setNow(Date.now());
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [running, active?.startedAt]);

  if (!steps.length && !running) return null;

  const summary = (
    <>
      <StatusIcon state={state} />
      <span className="run-progress-label">{label}</span>
      {steps.length > 0 && (
        <span className="run-progress-count">{steps.length} 个步骤</span>
      )}
    </>
  );

  return (
    <div className={`run-progress is-${state}`}>
      <span
        className="run-progress-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {label}
      </span>
      {steps.length ? (
        <details ref={details} className="run-progress-details">
          <summary className="run-progress-summary">
            {summary}
            <Icon name="down" size={13} className="run-progress-chevron" />
          </summary>
          <ol className="run-progress-steps" aria-label="本轮执行步骤">
            {steps.map((step, index) => {
              const stepState =
                step.status === 'running' && !running
                  ? 'incomplete'
                  : step.status;
              const elapsed = stepDuration(
                step,
                running && step.status === 'running' ? now : undefined,
              );
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
                    {stepLabel(step)}
                  </span>
                  <span className="run-progress-step-meta">
                    <span className="run-progress-step-status">
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
        </details>
      ) : (
        <div className="run-progress-summary is-static">{summary}</div>
      )}
    </div>
  );
}
