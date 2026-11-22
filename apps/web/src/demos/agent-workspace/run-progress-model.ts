import type { ChatMessage } from './workspace';

export interface ToolStep {
  id?: string;
  name: string;
  label?: string;
  expertSkill?: string;
  expertConnector?: string;
  status: string;
  startedAt?: number | string | null;
  finishedAt?: number | string | null;
  durationMs?: number | null;
  itinerary?: { destination?: string; transport?: string };
  finding?: string;
}

export interface RunStream {
  runId: string;
  text: string;
  steps: ToolStep[];
  activity?: string;
  phase?: string;
  runStatus: string;
  createdAt: number;
  runStartedAt?: number;
  runFinishedAt?: number;
}

export function createRunStream(runId: string): RunStream {
  return {
    runId,
    text: '',
    steps: [],
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
  for (const key of ['label', 'expertSkill', 'expertConnector'] as const) {
    if (typeof item[key] === 'string') step[key] = item[key].slice(0, 160);
  }
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
  if (
    step.status === 'completed' &&
    typeof item.finding === 'string' &&
    item.finding.trim()
  )
    step.finding = item.finding.trim().slice(0, 320);
  if (item.itinerary && typeof item.itinerary === 'object') {
    const values = item.itinerary as Record<string, unknown>;
    step.itinerary = {};
    for (const key of ['destination', 'transport'] as const) {
      const value = values[key];
      if (typeof value === 'string' && value.trim())
        step.itinerary[key] = value.trim().slice(0, 80);
    }
  }
  return step;
}

function updateStep(previous: ToolStep, next: ToolStep): ToolStep {
  if (previous.status !== 'running' && next.status === 'running')
    return previous;
  return { ...previous, ...next };
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
  const merged = updateStep(steps[index]!, next);
  if (merged === steps[index]) return steps;
  return steps.map((step, i) => (i === index ? merged : step));
}

function reconcileToolSteps(saved: ToolStep[], replay: ToolStep[]): ToolStep[] {
  const remaining = [...replay];
  const steps: ToolStep[] = [];
  for (const value of saved) {
    const previous = readStep(value);
    if (!previous) continue;
    // Both histories start at the beginning. Older calls without IDs match
    // the next unconsumed occurrence of that name, including separate retries.
    const index = remaining.findIndex((step) =>
      previous.id
        ? step.id === previous.id
        : !step.id && step.name === previous.name,
    );
    if (index < 0) steps.push(previous);
    else steps.push(updateStep(previous, remaining.splice(index, 1)[0]!));
  }
  return [...steps, ...remaining];
}

function runTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
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
    const phase =
      item.status === '待你回答'
        ? 'awaiting_input'
        : typeof item.phase === 'string'
          ? item.phase
          : stream.phase;
    const running = [...stream.steps]
      .reverse()
      .find((step) => step.status === 'running');
    return {
      ...stream,
      phase,
      runStartedAt: stream.runStartedAt ?? runTimestamp(item.runStartedAt),
      activity:
        running?.label ??
        (typeof item.label === 'string'
          ? item.label.slice(0, 160)
          : (phaseLabels[phase ?? ''] ?? stream.activity)),
    };
  }
  if (kind === 'error')
    return {
      ...stream,
      text: typeof item.message === 'string' && item.message.trim()
        ? item.message
        : stream.text,
      runStatus:
        item.runStatus === 'cancelled' || item.runStatus === 'interrupted'
          ? item.runStatus
          : 'failed',
      runStartedAt: stream.runStartedAt ?? runTimestamp(item.runStartedAt),
      runFinishedAt: runTimestamp(item.runFinishedAt),
      activity: '执行未完成',
    };
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
  const message: ChatMessage = {
    ...saved,
    id,
    role: 'assistant',
    runId: stream.runId,
    runStatus: stream.runStatus,
    text: stream.text || saved?.text || '',
    tools: reconcileToolSteps(saved?.tools ?? [], stream.steps),
    createdAt: saved?.createdAt ?? stream.createdAt,
    runStartedAt: saved?.runStartedAt ?? stream.runStartedAt,
    runFinishedAt: saved?.runFinishedAt ?? stream.runFinishedAt,
  };
  return index < 0
    ? [...messages, message]
    : messages.map((item, i) => (i === index ? message : item));
}
