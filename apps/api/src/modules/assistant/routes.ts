import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { AssistantService } from '@caixiaozhi/assistant';
import { RenameThreadSchema } from '@caixiaozhi/contracts/assistant';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
export type AssistantRoutesDependencies = {
  assistant: AssistantService;
  actor: (request: FastifyRequest, write: boolean) => Promise<ActorContext>;
  dataMode?: 'demo' | 'production';
};
const key = (request: FastifyRequest) => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value)
    throw new AppError('VALIDATION_ERROR', '请提供 Idempotency-Key。');
  return value;
};
export function registerAssistantRoutes(
  app: FastifyInstance,
  deps: AssistantRoutesDependencies,
) {
  const response = (request: FastifyRequest, data: unknown) =>
    dataResponse(request, data, deps.dataMode ?? 'demo');
  app.get('/api/v1/home', async (request) =>
    response(
      request,
      await deps.assistant.home(await deps.actor(request, false)),
    ),
  );
  app.get('/api/v1/threads', async (request) =>
    response(
      request,
      await deps.assistant.listThreads(await deps.actor(request, false)),
    ),
  );
  app.post('/api/v1/threads', async (request, reply) =>
    reply
      .code(201)
      .send(
        response(
          request,
          await deps.assistant.createThread(
            await deps.actor(request, true),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/threads/:id/snapshot',
    async (request) =>
      response(
        request,
        await deps.assistant.snapshot(
          await deps.actor(request, false),
          request.params.id,
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/threads/:id/messages',
    async (request, reply) =>
      reply
        .code(202)
        .send(
          response(
            request,
            await deps.assistant.acceptMessage(
              await deps.actor(request, true),
              request.params.id,
              request.body,
              key(request),
            ),
          ),
        ),
  );
  app.patch<{ Params: { id: string } }>(
    '/api/v1/threads/:id',
    async (request) =>
      response(
        request,
        await deps.assistant.renameThread(
          await deps.actor(request, true),
          request.params.id,
          RenameThreadSchema.parse(request.body),
          key(request),
        ),
      ),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/threads/:id',
    async (request) =>
      response(
        request,
        await deps.assistant.deleteThread(
          await deps.actor(request, true),
          request.params.id,
          z
            .strictObject({ expected_version: z.number().int().positive() })
            .parse(request.body).expected_version,
          key(request),
        ),
      ),
  );
  app.post<{ Params: { entry: string } }>(
    '/api/v1/home/entries/:entry/open',
    async (request, reply) =>
      reply.code(202).send(
        response(
          request,
          await deps.assistant.openEntry(
            await deps.actor(request, true),
            request.params.entry,
            z
              .strictObject({
                client_message_id: z.string().min(1),
                expected_binding_version: z
                  .number()
                  .int()
                  .positive()
                  .nullable()
                  .default(null),
              })
              .parse(request.body),
            key(request),
          ),
        ),
      ),
  );
  app.get<{ Params: { id: string } }>('/api/v1/cards/:id', async (request) =>
    response(
      request,
      await deps.assistant.getCard(
        await deps.actor(request, false),
        request.params.id,
      ),
    ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/cards/:id/drawer',
    async (request) =>
      response(
        request,
        await deps.assistant.drawer(
          await deps.actor(request, false),
          request.params.id,
          request.query,
        ),
      ),
  );
}
