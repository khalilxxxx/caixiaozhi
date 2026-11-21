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
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15.8 8.8V5.7a1.2 1.2 0 0 0-1.2-1.2h-3M2.4 17.9h3.3m20.6 0h3.3" />
      <rect x="5.7" y="9" width="20.6" height="17.2" rx="4.7" />
      <g className="run-face-gaze">
        <g className="run-face-lids">
          <path d="M11.9 15.1v3.4m8.2-3.4v3.4" strokeWidth="2.4" />
        </g>
      </g>
      <path
        className="run-face-light"
        d="M9.1 22.6h4.4"
        strokeWidth="1.5"
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

const emptySteps: ToolStep[] = [];
export function RunProgress({
  steps = emptySteps,
  running,
  status,
  activity,
  phase,
  onStop,
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
  const active = steps.filter((step) => step.status === 'running').at(-1);
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
  const toggleLabel = showElapsed ? elapsedLabel(elapsed) : '本轮进展';
  const sources = hasFeed
    ? []
    : [...new Set(steps.map(stepSource).filter(Boolean))];
  if (!live && !blocked && !hasFeed && !showElapsed && !sources.length)
    return null;

  // A replayed working event can still name a tool the snapshot already closed.
  const phaseActivity =
    phase === 'working' && steps.length > 0 ? undefined : activity?.trim();
  const currentLabel = active
    ? actionText(active)
    : phaseActivity ||
      (phase === 'responding'
        ? '正在整理回复'
        : phase === 'checking'
          ? '正在核对结果'
          : phase === 'thinking'
            ? '正在分析任务'
            : '正在处理');
  const last = items.at(-1);
  // With the feed collapsed, the last actual problem remains visible.
  const problemLabel =
    blocked &&
    last &&
    (last.status === 'failed' ||
      last.status === 'incomplete' ||
      last.status === 'cancelled')
      ? itemTitle(last)
      : undefined;
  return (
    <div ref={progress} className={`run-progress is-${state}`}>
      {hasFeed ? (
        <details
          className="run-progress-details"
          key={live ? 'live' : state}
          open={live || blocked}
        >
          <summary className="run-progress-toggle">
            {toggleLabel}
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
        <span className="run-progress-elapsed">{toggleLabel}</span>
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
          <FaceMark />
          <span className="run-progress-label" role="status">
            {currentLabel}
            <span
              aria-hidden="true"
              className="run-progress-glint"
              data-label={currentLabel}
            />
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
