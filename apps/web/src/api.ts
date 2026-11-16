import { ApiErrorResponseSchema } from '@caixiaozhi/contracts/common';
import type { Me } from '@caixiaozhi/contracts/identity';
import { FileViewSchema } from '@caixiaozhi/contracts/files';

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
let session: Me | null = null;
let invalidSession: () => void = () => {};
const pendingKeys = new Map<string, string>();
const controllers = new Set<AbortController>();
export function setApiSession(
  value: Me | null,
  onInvalid: () => void = () => {},
) {
  for (const controller of controllers) controller.abort();
  controllers.clear();
  pendingKeys.clear();
  session = value;
  invalidSession = onInvalid;
}
export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    key?: string;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const write = !['GET', 'HEAD'].includes(method);
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  const fingerprint = `${method}:${path}:${body ?? ''}`;
  const key =
    options.key ?? pendingKeys.get(fingerprint) ?? crypto.randomUUID();
  if (write) pendingKeys.set(fingerprint, key);
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(write
          ? {
              'Idempotency-Key': key,
              ...(session?.csrf_token
                ? { 'x-csrf-token': session.csrf_token }
                : {}),
            }
          : {}),
        ...options.headers,
      },
      body,
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
      cache: 'no-store',
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(payload);
      if (response.status === 401 && session) {
        setApiSession(null, invalidSession);
        invalidSession();
      }
      if (write) pendingKeys.delete(fingerprint);
      if (parsed.success)
        throw new ApiFailure(
          parsed.data.error.code,
          parsed.data.error.message,
          response.status,
          parsed.data.error.details,
        );
      throw new ApiFailure(
        'DEPENDENCY_UNAVAILABLE',
        '服务暂时不可用，请稍后重试。',
        response.status,
      );
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('data' in payload) ||
      !('meta' in payload)
    )
      throw new ApiFailure(
        'VALIDATION_ERROR',
        '服务响应格式异常，请刷新重试。',
        response.status,
      );
    if (write) pendingKeys.delete(fingerprint);
    return (payload as { data: T }).data;
  } catch (error) {
    if (
      error instanceof ApiFailure ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      throw error;
    throw new ApiFailure(
      'DEPENDENCY_UNAVAILABLE',
      '网络连接中断，请恢复连接后重试。',
      0,
    );
  } finally {
    controllers.delete(controller);
  }
}
export async function uploadBytes(
  target: { url: string; method: string; headers: Record<string, string> },
  bytes: ArrayBuffer,
) {
  const url = new URL(target.url, location.origin);
  if (
    url.origin !== location.origin ||
    !/^\/api\/v1\/files\/[^/]+\/content$/.test(url.pathname) ||
    target.method !== 'PUT'
  )
    throw new ApiFailure(
      'VALIDATION_ERROR',
      '上传地址不属于当前私有文件服务。',
      400,
    );
  const controller = new AbortController();
  controllers.add(controller);
  try {
    const response = await fetch(url, {
      method: target.method,
      credentials: 'include',
      headers: {
        ...target.headers,
        ...(session?.csrf_token ? { 'x-csrf-token': session.csrf_token } : {}),
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: bytes,
      signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const parsed = ApiErrorResponseSchema.safeParse(payload);
      throw new ApiFailure(
        parsed.success ? parsed.data.error.code : 'VALIDATION_ERROR',
        parsed.success ? parsed.data.error.message : '文件上传失败，请重试。',
        response.status,
      );
    }
    return FileViewSchema.parse((payload as { data: unknown }).data);
  } finally {
    controllers.delete(controller);
  }
}
export function formatMoney(
  value: { amount_minor: string; currency?: string } | null | undefined,
) {
  if (value === null || value === undefined) return '待确认';
  const number = BigInt(value.amount_minor),
    absolute = number < 0n ? -number : number;
  return `${number < 0n ? '-' : ''}¥${(absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(absolute % 100n).toString().padStart(2, '0')}`;
}
export const labels: Record<string, string> = {
  draft: '草稿',
  pending_manager: '待主管审批',
  pending_finance: '待财务审批',
  approved: '已批准',
  completed: '审批完成',
  returned: '已退回',
  withdrawn: '已撤回',
  pending: '待处理',
  succeeded: '已完成',
  rejected: '已拒绝',
  failed: '失败',
  unknown: '结果待核实',
  cancelled: '已停止',
  prepared: '待确认',
  confirmed: '已确认',
  executing: '处理中',
  queued: '排队中',
  running: '处理中',
  waiting_user: '等待补充',
  waiting_confirmation: '等待确认',
  reconciling: '正在核实',
  interrupted: '已中断',
  active: '已启用',
  disabled: '已停用',
  published: '已发布',
  ready: '已就绪',
  risk: '明确风险',
  incomplete: '材料待核',
  attention: '个人关注',
  low: '低风险',
  verified: '已核验（演示）',
  unavailable: '暂不可用',
  needs_confirmation: '待人工核对',
};
