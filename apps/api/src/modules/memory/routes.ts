import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import {
  MemoryInputSchema,
  SubscriptionInputSchema,
} from '@caixiaozhi/contracts/memory';
import type { MemoryService } from '@caixiaozhi/assistant';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
const version = z.strictObject({
  expected_version: z.number().int().positive(),
});
const key = (request: FastifyRequest) => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value)
    throw new AppError('VALIDATION_ERROR', '请提供 Idempotency-Key。');
  return value;
};
export function registerMemoryRoutes(
  app: FastifyInstance,
  deps: {
    memory: MemoryService;
    actor: (request: FastifyRequest, write: boolean) => Promise<ActorContext>;
    dataMode?: 'demo' | 'production';
  },
) {
  const response = (request: FastifyRequest, data: unknown) =>
    dataResponse(request, data, deps.dataMode ?? 'demo');
  app.get('/api/v1/memories', async (request) =>
    response(
      request,
      await deps.memory.listMemories(await deps.actor(request, false)),
    ),
  );
  app.post('/api/v1/memories', async (request, reply) =>
    reply
      .code(201)
      .send(
        response(
          request,
          await deps.memory.saveMemory(
            await deps.actor(request, true),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.patch<{ Params: { id: string } }>(
    '/api/v1/memories/:id',
    async (request) =>
      response(
        request,
        await deps.memory.updateMemory(
          await deps.actor(request, true),
          request.params.id,
          MemoryInputSchema.extend({
            expected_version: z.number().int().positive(),
          }).parse(request.body),
          key(request),
        ),
      ),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/memories/:id',
    async (request) =>
      response(
        request,
        await deps.memory.deleteMemory(
          await deps.actor(request, true),
          request.params.id,
          version.parse(request.body).expected_version,
          key(request),
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/memories/:id/restore',
    async (request) =>
      response(
        request,
        await deps.memory.restoreMemory(
          await deps.actor(request, true),
          request.params.id,
          version
            .extend({ revision_to_restore: z.number().int().positive() })
            .parse(request.body),
          key(request),
        ),
      ),
  );
  app.get('/api/v1/subscriptions', async (request) =>
    response(
      request,
      await deps.memory.listSubscriptions(await deps.actor(request, false)),
    ),
  );
  app.post('/api/v1/subscriptions', async (request, reply) =>
    reply
      .code(201)
      .send(
        response(
          request,
          await deps.memory.createSubscription(
            await deps.actor(request, true),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.patch<{ Params: { id: string } }>(
    '/api/v1/subscriptions/:id',
    async (request) => {
      const raw = z.record(z.string(), z.unknown()).parse(request.body);
      const expected_version = z
        .number()
        .int()
        .positive()
        .parse(raw.expected_version);
      const { expected_version: _expected, ...input } = raw;
      return response(
        request,
        await deps.memory.updateSubscription(
          await deps.actor(request, true),
          request.params.id,
          { ...SubscriptionInputSchema.parse(input), expected_version },
          key(request),
        ),
      );
    },
  );
  for (const action of ['pause', 'resume'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/v1/subscriptions/:id/${action}`,
      async (request) =>
        response(
          request,
          await deps.memory.changeSubscription(
            await deps.actor(request, true),
            request.params.id,
            action,
            version.parse(request.body).expected_version,
            key(request),
          ),
        ),
    );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/subscriptions/:id',
    async (request) =>
      response(
        request,
        await deps.memory.changeSubscription(
          await deps.actor(request, true),
          request.params.id,
          'delete',
          version.parse(request.body).expected_version,
          key(request),
        ),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/subscriptions/:id/occurrences',
    async (request) =>
      response(
        request,
        await deps.memory.occurrences(
          await deps.actor(request, false),
          request.params.id,
        ),
      ),
  );
  app.post<{ Params: { id: string; occ: string } }>(
    '/api/v1/subscriptions/:id/occurrences/:occ/retry',
    async (request) =>
      response(
        request,
        await deps.memory.retryOccurrence(
          await deps.actor(request, true),
          request.params.id,
          request.params.occ,
          version.parse(request.body).expected_version,
          key(request),
        ),
      ),
  );
  app.get('/api/v1/inbox', async (request) =>
    response(
      request,
      await deps.memory.listInbox(await deps.actor(request, false)),
    ),
  );
  app.get('/api/v1/inbox/unread-count', async (request) =>
    response(request, {
      count: await deps.memory.unreadCount(await deps.actor(request, false)),
    }),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/inbox/:id/open',
    async (request) =>
      response(
        request,
        await deps.memory.openInbox(
          await deps.actor(request, true),
          request.params.id,
          version.parse(request.body).expected_version,
          key(request),
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/inbox/:id/read',
    async (request) =>
      response(
        request,
        await deps.memory.markRead(
          await deps.actor(request, true),
          request.params.id,
          version
            .extend({ read_revision: z.number().int().positive() })
            .parse(request.body),
          key(request),
        ),
      ),
  );
  app.delete<{ Params: { id: string } }>('/api/v1/inbox/:id', async (request) =>
    response(
      request,
      await deps.memory.deleteInbox(
        await deps.actor(request, true),
        request.params.id,
        version.parse(request.body).expected_version,
        key(request),
      ),
    ),
  );
}
