import type { ChatMessage } from './workspace';

export interface ToolStep {
  id?: string;
  name: string;
  label?: string;
  status: string;
  startedAt?: number | string | null;
  finishedAt?: number | string | null;
  durationMs?: number | null;
}

export interface RunStream {
  runId: string;
  text: string;
  steps: ToolStep[];
  activity?: string;
  phase?: string;
  runStatus: string;
  createdAt: number;
}

export function createRunStream(
  runId: string,
  steps: ToolStep[] = [],
): RunStream {
  return {
    runId,
    text: '',
    steps: steps.flatMap((step) => {
      const safe = readStep(step);
      return safe ? [safe] : [];
    }),
    runStatus: 'running',
    createdAt: Date.now(),
  };
}

const statuses = new Set(['running', 'completed', 'failed', 'cancelled']);
const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'incomplete',
  'awaiting_input',
  'waiting',
  'paused',
]);
const phaseLabels: Record<string, string> = {
  thinking: '正在分析任务',
  working: '正在处理',
  checking: '正在核对结果',
  responding: '正在整理回复',
  awaiting_input: '待你回答',
};

function readStep(value: unknown): ToolStep | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.name !== 'string' ||
    typeof item.status !== 'string' ||
    !statuses.has(item.status)
  )
    return null;
  const step: ToolStep = { name: item.name.slice(0, 160), status: item.status };
  if (typeof item.id === 'string') step.id = item.id;
  if (typeof item.label === 'string') step.label = item.label.slice(0, 160);
  for (const key of ['startedAt', 'finishedAt'] as const) {
    const time = item[key];
    if (
      typeof time === 'string' ||
      (typeof time === 'number' && Number.isFinite(time))
    )
      step[key] = time;
  }
  if (
    typeof item.durationMs === 'number' &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0
  )
    step.durationMs = item.durationMs;
  return step;
}

export function mergeToolStep(steps: ToolStep[], value: unknown): ToolStep[] {
  const next = readStep(value);
  if (!next) return steps;
  const index = next.id
    ? steps.findIndex((step) => step.id === next.id)
    : steps.findIndex(
        (step) =>
          !step.id && step.name === next.name && step.status === 'running',
      );
  if (index < 0) return [...steps, next];
  const previous = steps[index]!;
  // Replayed starts cannot turn a persisted terminal step back into a spinner.
  if (previous.status !== 'running' && next.status === 'running') return steps;
  return steps.map((step, i) =>
    i === index ? { ...previous, ...next } : step,
  );
}

export function reduceRunEvent(
  stream: RunStream,
  kind: string,
  value: unknown,
): RunStream {
  if (!value || typeof value !== 'object') return stream;
  const item = value as Record<string, unknown>;
  if (kind === 'tool') {
    const steps = mergeToolStep(stream.steps, value);
    if (steps === stream.steps) return stream;
    const running = [...steps]
      .reverse()
      .find((step) => step.status === 'running');
    return {
      ...stream,
      steps,
      activity: running?.label ?? (running ? '正在处理' : '正在整理结果'),
    };
  }
  if (kind === 'delta' && typeof item.text === 'string')
    return { ...stream, text: stream.text + item.text };
  if (kind === 'status') {
    const phase = typeof item.phase === 'string' ? item.phase : stream.phase;
    const running = [...stream.steps]
      .reverse()
      .find((step) => step.status === 'running');
    return {
      ...stream,
      phase,
      activity:
        running?.label ??
        (typeof item.label === 'string'
          ? item.label.slice(0, 160)
          : (phaseLabels[phase ?? ''] ?? stream.activity)),
    };
  }
  if (kind === 'error')
    return { ...stream, runStatus: 'failed', activity: '执行未完成' };
  return stream;
}

export function mergeRunMessages(
  messages: ChatMessage[],
  stream?: RunStream,
): ChatMessage[] {
  if (!stream) return messages;
  const id = `assistant-${stream.runId}`;
  const index = messages.findIndex(
    (message) => message.id === id || message.runId === stream.runId,
  );
  const saved = index < 0 ? undefined : messages[index];
  if (saved?.runStatus && terminal.has(saved.runStatus)) return messages;
  let steps = (saved?.tools ?? []).flatMap((step) => {
    const safe = readStep(step);
    return safe ? [safe] : [];
  });
  for (const step of stream.steps) steps = mergeToolStep(steps, step);
  const message: ChatMessage = {
    ...saved,
    id,
    role: 'assistant',
    runId: stream.runId,
    runStatus: stream.runStatus,
    text: stream.text || saved?.text || '',
    tools: steps,
    createdAt: saved?.createdAt ?? stream.createdAt,
  };
  return index < 0
    ? [...messages, message]
    : messages.map((item, i) => (i === index ? message : item));
}
