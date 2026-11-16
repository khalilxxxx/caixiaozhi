import type { Task, WorkspaceState } from './workspace';

export interface WorkspaceSnapshot {
  state: WorkspaceState;
  revision: number;
}
export interface WorkspacePatch {
  data?: Record<string, unknown>;
  tasks?: Task[];
  activeTask?: string | null;
  deletedTaskIds?: string[];
}
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  sha256?: string;
  text?: string;
  status: string;
  [key: string]: unknown;
}
export interface RuntimeStatus {
  state: 'loading' | 'ready' | 'saving' | 'offline';
  message?: string;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public payload: any,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/local${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers:
        body === undefined || body instanceof FormData
          ? undefined
          : { 'Content-Type': 'application/json' },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('无法连接本地服务，请检查服务后重试。', 0, null);
  }
  const payload = await response.json().catch(() => null);
  if (response.ok && payload === null)
    throw new ApiError('本地接口尚未就绪，请检查服务后重试。', response.status, null);
  if (!response.ok)
    throw new ApiError(
      payload?.message ?? payload?.detail ?? `请求失败（${response.status}）`,
      response.status,
      payload,
    );
  return payload as T;
}
export function uploadFile(file: File) {
  const body = new FormData();
  body.append('file', file);
  return api<{ file: UploadedFile }>('/files', body);
}

const emptyState: WorkspaceState = { data: {}, tasks: [], activeTask: null };
let server: WorkspaceSnapshot = { state: emptyState, revision: -1 };
type Operation = { before: WorkspaceState; after: WorkspaceState };
let pending: Operation[] = [];
let saving: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(snapshot: WorkspaceSnapshot) => void>();
const statusListeners = new Set<(status: RuntimeStatus) => void>();
let status: RuntimeStatus = { state: 'loading' };
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Apply only fields the user changed; retain concurrent tool results and run messages.
export function rebaseWorkspaceValue(
  before: any,
  after: any,
  remote: any,
): any {
  if (equal(before, after)) return remote;
  if (object(before) && object(after)) {
    const result = { ...(object(remote) ? remote : {}) };
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (equal(before[key], after[key])) continue;
      if (!(key in after)) delete result[key];
      else
        result[key] = rebaseWorkspaceValue(
          before[key],
          after[key],
          result[key],
        );
    }
    return result;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    [...before, ...after].every((v) => object(v) && typeof v.id === 'string')
  ) {
    const previous = new Map(before.map((v) => [v.id, v]));
    const next = new Map(after.map((v) => [v.id, v]));
    const result = (Array.isArray(remote) ? remote : []).filter(
      (v) => !previous.has(v.id) || next.has(v.id),
    );
    for (const item of after) {
      if (equal(previous.get(item.id), item)) continue;
      const i = result.findIndex((v) => v.id === item.id);
      const merged = rebaseWorkspaceValue(
        previous.get(item.id),
        item,
        i < 0 ? undefined : result[i],
      );
      if (i < 0) result.push(merged);
      else result[i] = merged;
    }
    return result;
  }
  return structuredClone(after);
}
function optimisticState() {
  return pending.reduce(
    (state, op) =>
      rebaseWorkspaceValue(op.before, op.after, state) as WorkspaceState,
    server.state,
  );
}
function emit() {
  const snapshot = { state: optimisticState(), revision: server.revision };
  listeners.forEach((listener) => listener(snapshot));
}
function setStatus(next: RuntimeStatus) {
  status = next;
  statusListeners.forEach((listener) => listener(next));
}
export function subscribeWorkspace(
  listener: (snapshot: WorkspaceSnapshot) => void,
) {
  listeners.add(listener);
  if (server.revision >= 0)
    listener({ state: optimisticState(), revision: server.revision });
  return () => {
    listeners.delete(listener);
  };
}
export function subscribeRuntimeStatus(
  listener: (value: RuntimeStatus) => void,
) {
  statusListeners.add(listener);
  listener(status);
  return () => {
    statusListeners.delete(listener);
  };
}
export function acceptWorkspace(snapshot: WorkspaceSnapshot) {
  if (snapshot.revision >= server.revision) {
    server = snapshot;
    emit();
  }
}
export async function readWorkspace(): Promise<WorkspaceSnapshot> {
  try {
    const snapshot = await api<WorkspaceSnapshot>('/workspace');
    acceptWorkspace(snapshot);
    setStatus({ state: pending.length ? 'saving' : 'ready' });
    return { state: optimisticState(), revision: server.revision };
  } catch (error) {
    setStatus({ state: 'offline', message: (error as Error).message });
    throw error;
  }
}
export function workspacePatch(
  before: WorkspaceState,
  after: WorkspaceState,
): WorkspacePatch {
  const data = Object.fromEntries(
    Object.entries(after.data).filter(
      ([key, value]) => !equal(before.data[key], value),
    ),
  );
  const tasks = after.tasks.filter(
    (task) =>
      !equal(
        before.tasks.find((previous) => previous.id === task.id),
        task,
      ),
  );
  const deletedTaskIds = before.tasks
    .filter((task) => !after.tasks.some((next) => next.id === task.id))
    .map((task) => task.id);
  return {
    ...(Object.keys(data).length ? { data } : {}),
    ...(tasks.length ? { tasks } : {}),
    ...(before.activeTask !== after.activeTask
      ? { activeTask: after.activeTask }
      : {}),
    ...(deletedTaskIds.length ? { deletedTaskIds } : {}),
  };
}
export function saveWorkspace(patch: WorkspacePatch) {
  if (server.revision < 0) return;
  const before = optimisticState();
  const after: WorkspaceState = {
    data: { ...before.data, ...patch.data },
    tasks: [
      ...before.tasks
        .filter((task) => !patch.deletedTaskIds?.includes(task.id))
        .map(
          (task) => patch.tasks?.find((next) => next.id === task.id) ?? task,
        ),
      ...(patch.tasks ?? []).filter(
        (task) => !before.tasks.some((previous) => previous.id === task.id),
      ),
    ],
    activeTask:
      'activeTask' in patch ? (patch.activeTask ?? null) : before.activeTask,
  };
  if (equal(before, after)) return;
  pending.push({ before, after });
  emit();
  setStatus({ state: 'saving' });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushWorkspace().catch(() => {});
  }, 250);
}
export async function flushWorkspace(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (saving) {
    await saving;
    if (pending.length) return flushWorkspace();
    return;
  }
  if (!pending.length) return;
  saving = (async () => {
    let conflicts = 0;
    while (pending.length) {
      const count = pending.length;
      const after = pending
        .slice(0, count)
        .reduce(
          (state, op) => rebaseWorkspaceValue(op.before, op.after, state),
          server.state,
        ) as WorkspaceState;
      const patch = workspacePatch(server.state, after);
      if (!Object.keys(patch).length) {
        pending.splice(0, count);
        continue;
      }
      try {
        const snapshot = await api<WorkspaceSnapshot>(
          '/workspace',
          { baseRevision: server.revision, ...patch },
          'PATCH',
        );
        pending.splice(0, count);
        if (snapshot.revision >= server.revision) server = snapshot;
        emit();
        conflicts = 0;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          conflicts++ < 4
        ) {
          const latest = error.payload?.workspace ?? error.payload;
          if (latest?.state && typeof latest.revision === 'number')
            acceptWorkspace(latest);
          else await readWorkspace();
          continue;
        }
        setStatus({ state: 'offline', message: (error as Error).message });
        throw error;
      }
    }
    setStatus({ state: 'ready' });
  })();
  try {
    await saving;
  } finally {
    saving = null;
  }
}
