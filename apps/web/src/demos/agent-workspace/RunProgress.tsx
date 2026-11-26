import { useEffect, useRef, useState } from 'react';
import type { ToolStep } from './run-progress-model';
import {
  actionText,
  elapsedLabel,
  feedItems,
  hasMultipleBusinessActions,
  itemTitle,
  longRunMs,
  openingScope,
  runState,
  stateLabels,
  stepSource,
  toolInfo,
  validTime,
} from './active-run-feed';
import { Icon } from './ui';
import './run-progress.css';

interface RunProgressProps {
  steps?: ToolStep[];
  running: boolean;
  status?: string;
  activity?: string;
  phase?: string;
  onStop?: () => void;
  stopping?: boolean;
  runStartedAt?: number;
  runFinishedAt?: number;
}

function FaceMark() {
  return (
    <svg
      className="run-progress-face"
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.2 10.1c0-2.3.4-4.6 1.3-6.6 1.8.4 3.6 1.7 5 3.4m3 0c1.4-1.7 3.2-3 5-3.4.9 2 1.3 4.3 1.3 6.6" />
      <path d="M12 7.4c1.5 0 2.6-.6 4-.6 3.2 0 5.3 2.9 5.3 6.4 0 4.6-3.5 7.2-9.3 7.2s-9.3-2.6-9.3-7.2c0-3.5 2.1-6.4 5.3-6.4 1.4 0 2.5.6 4 .6Z" />
      <g className="run-face-gaze">
        <g className="run-face-lids" fill="currentColor" stroke="none">
          <rect x="8.1" y="11" width="2.2" height="4" rx="1.1" />
          <rect x="13.7" y="11" width="2.2" height="4" rx="1.1" />
        </g>
      </g>
      <path
        className="run-face-light"
        d="M7.5 17.6h3.6"
        strokeWidth="1.35"
        opacity="0"
      />
    </svg>
  );
}

function useElapsed(running: boolean, start?: number, end?: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !validTime(start)) return;
    // Short runs need no ticking clock. Wake once at the long-run threshold.
    let interval: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Date.now());
    const timeout = setTimeout(
      () => {
        tick();
        interval = setInterval(tick, 1000);
      },
      Math.max(0, start + longRunMs - Date.now()),
    );
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [running, start]);
  const finish = running ? now : end;
  return validTime(start) && validTime(finish) && finish >= start
    ? finish - start
    : null;
}

function useMotionVisibility(animate: boolean) {
  const progress = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = progress.current;
    const row = element?.querySelector('.run-progress-summary');
    if (!animate || !element || !row) return;
    let inView = true;
    const update = () => {
      element.dataset.motionPaused = String(document.hidden || !inView);
    };
    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            if (!entry) return;
            inView = entry.isIntersecting;
            update();
          })
        : undefined;
    update();
    observer?.observe(row);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', update);
      delete element.dataset.motionPaused;
    };
  }, [animate]);
  return progress;
}

function latestUnresolvedAction(items: ReturnType<typeof feedItems>) {
  const completedLater = new Set<string>();
  for (const item of [...items].reverse()) {
    const action = JSON.stringify([item.name, item.label, item.source]);
    if (item.status === 'completed') completedLater.add(action);
    else if (!completedLater.has(action)) return itemTitle(item);
  }
}

const emptySteps: ToolStep[] = [];
export function RunProgress({
  steps = emptySteps,
  running,
  status,
  activity,
  phase,
  onStop,
  stopping = false,
  runStartedAt,
  runFinishedAt,
}: RunProgressProps) {
  const state = runState(status, running, steps, phase);
  const live = state === 'running';
  const blocked = state !== 'completed' && state !== 'history' && !live;
  // A restart marks when the interruption was discovered, not when work stopped.
  const uncertainEnd =
    status === 'interrupted' ||
    status === 'incomplete' ||
    state === 'incomplete';
  const elapsed = useElapsed(
    live,
    runStartedAt,
    uncertainEnd ? undefined : runFinishedAt,
  );
  const progress = useMotionVisibility(live);
  const runningSteps = steps.filter((step) => step.status === 'running');
  const active = runningSteps.at(-1);
  const items = feedItems(steps, live || state === 'waiting');
  const slow = elapsed !== null && elapsed >= longRunMs;
  const needsContext =
    slow ||
    state === 'history' ||
    blocked ||
    hasMultipleBusinessActions(steps) ||
    steps.some((step) => step.status === 'failed');
  const scope = needsContext ? openingScope(steps) : undefined;
  const hasFeed = needsContext && (items.length > 0 || !!scope);
  const showElapsed = elapsed !== null && (slow || (!live && hasFeed));
  const baseLabel = showElapsed ? elapsedLabel(elapsed) : '本轮进展';
  const toggleLabel =
    hasFeed && !live && !blocked && items.length > 0
      ? showElapsed
        ? `已完成 ${items.length} 步 · ${baseLabel}`
        : `本轮进展 · ${items.length} 步`
      : baseLabel;
  const sources = hasFeed
    ? []
    : [...new Set(steps.map(stepSource).filter(Boolean))];
  if (!live && !blocked && !hasFeed && !showElapsed && !sources.length)
    return null;

  // A replayed working event can still name a tool the snapshot already closed.
  const phaseActivity =
    phase === 'working' && steps.length > 0 ? undefined : activity?.trim();
  const currentLabel = active
    ? runningSteps.length > 1
      ? `${actionText(active)}（共 ${runningSteps.length} 项并行）`
      : actionText(active)
    : phaseActivity ||
      (phase === 'responding'
        ? '正在整理回复'
        : phase === 'checking'
          ? '正在核对结果'
          : phase === 'thinking'
            ? '正在分析任务'
            : '正在处理');
  const problemLabel =
    blocked && state !== 'waiting' ? latestUnresolvedAction(items) : undefined;
  return (
    <div ref={progress} className={`run-progress is-${state}`}>
      {hasFeed ? (
        <details className="run-progress-details" open={live || blocked}>
          <summary className="run-progress-toggle">
            <span>{toggleLabel}</span>
            <Icon name="chevron" size={12} className="run-progress-chevron" />
          </summary>
          {scope && <p className="run-progress-scope">{scope}</p>}
          {items.length > 0 && (
            <ol className="run-progress-steps" aria-label="办理进展">
              {items.map((item) => (
                <li
                  key={item.key}
                  className={`run-progress-step is-${item.status}`}
                >
                  <div className="run-progress-step-title">
                    <Icon
                      name={
                        item.status === 'failed' || item.status === 'incomplete'
                          ? 'alert'
                          : item.status === 'cancelled'
                            ? 'stop'
                            : 'check'
                      }
                      size={13}
                    />
                    <span>{itemTitle(item)}</span>
                  </div>
                  {item.source && (
                    <small className="run-expert-source">{item.source}</small>
                  )}
                  {item.findings.map((fact) => (
                    <p key={fact} className="run-progress-finding">
                      {fact}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
          )}
        </details>
      ) : showElapsed ? (
        <span className="run-progress-elapsed">{baseLabel}</span>
      ) : null}
      {live ? (
        <div
          className="run-progress-summary"
          data-activity={
            active
              ? (toolInfo(active.name)?.[0] ?? 'working')
              : (phase ?? 'thinking')
          }
        >
          <span className="run-progress-action">
            <FaceMark />
            <span className="run-progress-label" role="status">
              <span key={currentLabel} className="run-progress-glint">
                {currentLabel}
              </span>
            </span>
          </span>
          {onStop && (
            <button
              className="run-progress-stop"
              type="button"
              disabled={stopping}
              onClick={onStop}
            >
              <Icon name="stop" size={12} />
              {stopping ? '正在停止…' : '停止办理'}
            </button>
          )}
        </div>
      ) : blocked ? (
        <p className="run-progress-state" role="status">
          {stateLabels[state]}
          {problemLabel && (
            <span className="run-problem-action"> · {problemLabel}</span>
          )}
        </p>
      ) : null}
      {sources.map((source) => (
        <small key={source} className="run-expert-source">
          {source}
        </small>
      ))}
    </div>
  );
}
