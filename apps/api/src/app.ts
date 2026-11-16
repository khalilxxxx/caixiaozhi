import { randomUUID } from 'node:crypto';
import { AppError } from '@caixiaozhi/platform/errors';
import { ZodError } from 'zod';
import Fastify from 'fastify';
import { setHttpDataMode } from './http.js';
import {
  ApiErrorResponseSchema,
  HealthResponseSchema,
} from '@caixiaozhi/contracts';

type AppOptions = {
  database: () => Promise<void>;
  storage: () => Promise<void>;
  dataMode: 'demo' | 'production';
  logLevel?: string;
  dependencyTimeoutMs?: number;
};

async function probe(
  check: () => Promise<void>,
  timeoutMs: number,
): Promise<'ready' | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('dependency_timeout')),
          timeoutMs,
        );
      }),
    ]);
    return 'ready';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}

export function createApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logLevel ? { level: options.logLevel } : false,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 20_971_520,
  });
  setHttpDataMode(app, options.dataMode);
  const meta = (requestId: string) => ({
    request_id: requestId,
    trace_id: requestId,
    server_time: new Date().toISOString(),
    data_mode: options.dataMode,
  });

  app.get('/api/v1/health/live', async (request) =>
    HealthResponseSchema.parse({
      data: { service: 'api', status: 'alive' },
      meta: meta(request.id),
    }),
  );

  app.get('/api/v1/health/ready', async (request, reply) => {
    const timeout = options.dependencyTimeoutMs ?? 2500;
    const [database, storage] = await Promise.all([
      probe(options.database, timeout),
      probe(options.storage, timeout),
    ]);
    const dependencies = { database, storage };
    if (database !== 'ready' || storage !== 'ready') {
      return reply.code(503).send(
        ApiErrorResponseSchema.parse({
          error: {
            code: 'DEPENDENCY_UNAVAILABLE',
            message: '基础服务尚未就绪，请检查数据库、迁移和私有文件存储。',
            retryable: true,
            details: dependencies,
          },
          meta: meta(request.id),
        }),
      );
    }
    return HealthResponseSchema.parse({
      data: { service: 'api', status: 'ready', dependencies },
      meta: meta(request.id),
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      ApiErrorResponseSchema.parse({
        error: {
          code: 'NOT_FOUND',
          message: '请求的资源不存在。',
          retryable: false,
        },
        meta: meta(request.id),
      }),
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send(
        ApiErrorResponseSchema.parse({
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(error.details ? { details: error.details } : {}),
          },
          meta: meta(request.id),
        }),
      );
    }
    const statusCode =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : undefined;
    const invalidRequest =
      error instanceof ZodError ||
      (statusCode !== undefined && statusCode >= 400 && statusCode < 500);
    request.log.error(
      { event: 'request.failed', request_id: request.id },
      '请求处理失败',
    );
    return reply.code(invalidRequest ? 400 : 503).send(
      ApiErrorResponseSchema.parse({
        error: {
          code: invalidRequest ? 'VALIDATION_ERROR' : 'DEPENDENCY_UNAVAILABLE',
          message: invalidRequest ? '请求格式或字段无效。' : '服务暂时不可用。',
          retryable: !invalidRequest,
          ...(error instanceof ZodError
            ? {
                details: {
                  fields: error.issues.map((issue) => ({
                    path: issue.path.join('.'),
                    message:
                      issue.code === 'unrecognized_keys'
                        ? '包含未定义字段。'
                        : issue.code === 'invalid_value'
                          ? '字段选项无效。'
                          : '字段格式无效或缺失。',
                  })),
                },
              }
            : {}),
        },
        meta: meta(request.id),
      }),
    );
  });
  return app;
}
