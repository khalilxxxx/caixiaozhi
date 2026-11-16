import {
  ApiErrorResponseSchema,
  createApiResponseSchema,
} from '@caixiaozhi/contracts/common';
import {
  HealthDataSchema,
  HealthDependenciesSchema,
} from '@caixiaozhi/contracts/health';

const HealthResponseSchema = createApiResponseSchema(HealthDataSchema);

type HealthResponse = Extract<
  ReturnType<typeof HealthResponseSchema.parse>,
  { data: unknown }
>;
type HealthDependencies = ReturnType<typeof HealthDependenciesSchema.parse>;

export type HealthCheck =
  | { kind: 'available'; response: HealthResponse }
  | {
      kind: 'not_ready';
      dependencies: HealthDependencies;
      meta: ReturnType<typeof ApiErrorResponseSchema.parse>['meta'];
    }
  | { kind: 'error'; message: string };

export async function checkHealth(
  endpoint: 'live' | 'ready',
  signal: AbortSignal,
): Promise<HealthCheck> {
  const timeout = AbortSignal.timeout(8_000);

  try {
    const response = await fetch(`/api/v1/health/${endpoint}`, {
      signal: AbortSignal.any([signal, timeout]),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const payload: unknown = await response.json();

    if (endpoint === 'ready' && response.status === 503) {
      const error = ApiErrorResponseSchema.safeParse(payload);
      const dependencies = HealthDependenciesSchema.safeParse(
        error.success ? error.data.error.details : undefined,
      );

      if (
        error.success &&
        error.data.error.code === 'DEPENDENCY_UNAVAILABLE' &&
        dependencies.success
      ) {
        return {
          kind: 'not_ready',
          dependencies: dependencies.data,
          meta: error.data.meta,
        };
      }
    }

    if (!response.ok) {
      return {
        kind: 'error',
        message: '服务暂时无法完成健康检查，请稍后刷新。',
      };
    }

    const result = HealthResponseSchema.safeParse(payload);
    const expectedStatus = endpoint === 'live' ? 'alive' : 'ready';

    if (
      !result.success ||
      !('data' in result.data) ||
      result.data.data.status !== expectedStatus ||
      (endpoint === 'ready' &&
        (result.data.data.dependencies?.database !== 'ready' ||
          result.data.data.dependencies.storage !== 'ready'))
    ) {
      return {
        kind: 'error',
        message: '健康检查响应格式异常，请检查 API 运行日志后刷新。',
      };
    }

    return { kind: 'available', response: result.data };
  } catch {
    return {
      kind: 'error',
      message: timeout.aborted
        ? '健康检查请求超时，请确认服务运行状态后刷新。'
        : '无法获取健康状态，请确认 API 服务与网络连接后刷新。',
    };
  }
}
