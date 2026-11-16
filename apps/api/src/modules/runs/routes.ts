import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ActorContext } from '@caixiaozhi/contracts';
import {
  CancelRunSchema,
  CreateRunSchema,
  ResumeRunSchema,
} from '@caixiaozhi/contracts/runs';
import { AppError } from '@caixiaozhi/platform/errors';
import type { RunService } from './service.js';
import { dataResponse } from '../../http.js';

export type RunRouteDependencies = {
  runs: RunService;
  actor: (request: FastifyRequest, write: boolean) => Promise<ActorContext>;
  disconnectAfterEvent?: (
    actor: ActorContext,
    runId: string,
  ) => Promise<boolean>;
  dataMode?: 'demo' | 'production';
};
const key = (request: FastifyRequest) => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value)
    throw new AppError('VALIDATION_ERROR', '请提供 Idempotency-Key。');
  return value;
};
export function registerRunRoutes(
  app: FastifyInstance,
  deps: RunRouteDependencies,
) {
  const envelope = (request: FastifyRequest, data: unknown) =>
    dataResponse(request, data, deps.dataMode ?? 'demo');
  app.post('/api/v1/runs', async (request, reply) => {
    const actor = await deps.actor(request, true);
    const run = await deps.runs.createRun(
      actor,
      CreateRunSchema.parse(request.body),
      key(request),
    );
    return reply.code(202).send(envelope(request, run));
  });
  app.get('/api/v1/runs', async (request) =>
    envelope(request, {
      items: await deps.runs.listRuns(await deps.actor(request, false)),
      next_cursor: null,
    }),
  );
  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', async (request) =>
    envelope(
      request,
      await deps.runs.getRun(
        await deps.actor(request, false),
        request.params.id,
      ),
    ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/runs/:id/snapshot',
    async (request) =>
      envelope(
        request,
        await deps.runs.snapshot(
          await deps.actor(request, false),
          request.params.id,
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/runs/:id/resume',
    async (request, reply) => {
      const actor = await deps.actor(request, true);
      return reply
        .code(202)
        .send(
          envelope(
            request,
            await deps.runs.resumeRun(
              actor,
              request.params.id,
              ResumeRunSchema.parse(request.body),
              key(request),
            ),
          ),
        );
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/runs/:id/cancel',
    async (request, reply) => {
      const actor = await deps.actor(request, true);
      return reply
        .code(202)
        .send(
          envelope(
            request,
            await deps.runs.cancelRun(
              actor,
              request.params.id,
              CancelRunSchema.parse(request.body),
              key(request),
            ),
          ),
        );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/v1/runs/:id/events',
    async (request, reply) => {
      const actor = await deps.actor(request, false);
      const id = request.params.id;
      if (
        request.query.after !== undefined &&
        request.headers['last-event-id'] !== undefined &&
        request.query.after !== request.headers['last-event-id']
      )
        throw new AppError(
          'VALIDATION_ERROR',
          'after 与 Last-Event-ID 不一致。',
        );
      const raw =
        request.query.after ?? request.headers['last-event-id'] ?? '0';
      if (typeof raw !== 'string' || !/^\d+$/.test(raw))
        throw new AppError('VALIDATION_ERROR', '事件游标无效。');
      let cursor = Number(raw);
      let events = await deps.runs.events(actor, id, cursor);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      reply.raw.on('close', () => {
        closed = true;
      });
      let heartbeatAt = Date.now();
      try {
        while (!closed) {
          for (const event of events) {
            if (closed) break;
            reply.raw.write(
              `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            cursor = event.seq;
            if (await deps.disconnectAfterEvent?.(actor, id)) {
              closed = true;
              break;
            }
          }
          if (closed) break;
          const run = await deps.runs.getRun(actor, id);
          if (
            ['succeeded', 'failed', 'cancelled'].includes(run.status) &&
            cursor >= run.last_seq
          )
            break;
          if (Date.now() - heartbeatAt >= 15000) {
            reply.raw.write(': heartbeat\n\n');
            heartbeatAt = Date.now();
          }
          await delay(500);
          if (closed) break;
          events = await deps.runs.events(actor, id, cursor);
        }
      } catch {
        // 撤权、注销和连接错误立即结束订阅，不把内部异常或正文写入日志。
      } finally {
        if (!closed) reply.raw.end();
      }
    },
  );
}
