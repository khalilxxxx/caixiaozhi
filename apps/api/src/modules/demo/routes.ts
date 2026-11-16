import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import { DemoGuardSchema } from '@caixiaozhi/contracts/demo';
import type { DemoService } from '@caixiaozhi/demo';
import type { DemoScenarioController } from '@caixiaozhi/demo/scenarios';
import { StartDemoJourneySchema } from '@caixiaozhi/contracts/demo-scenarios';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
const key = (request: FastifyRequest) => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value)
    throw new AppError('VALIDATION_ERROR', '请提供 Idempotency-Key。');
  return value;
};
export function registerDemoRoutes(
  app: FastifyInstance,
  deps: {
    demo: DemoService;
    scenarios?: DemoScenarioController;
    appMode: 'demo' | 'test' | 'production';
    actor: (request: FastifyRequest, write: boolean) => Promise<ActorContext>;
  },
) {
  if (deps.appMode === 'production') return;
  const response = (request: FastifyRequest, data: unknown) =>
    dataResponse(request, data, 'demo');
  app.get('/api/v1/demo/environments/current', async (request) =>
    response(
      request,
      await deps.demo.current(await deps.actor(request, false)),
    ),
  );
  app.get('/api/v1/demo/manifest', async (request) =>
    response(
      request,
      await deps.demo.manifest(await deps.actor(request, false)),
    ),
  );
  app.post('/api/v1/demo/reset', async (request, reply) =>
    reply
      .code(202)
      .send(
        response(
          request,
          await deps.demo.requestReset(
            await deps.actor(request, true),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.post('/api/v1/demo/seed', async (request) => {
    const actor = await deps.actor(request, true);
    DemoGuardSchema.extend({
      seed_version: z.literal('finance-agent-v1.0'),
    }).parse(request.body);
    return response(request, await deps.demo.manifest(actor));
  });
  app.get<{ Params: { id: string } }>(
    '/api/v1/demo/reset-jobs/:id',
    async (request) =>
      response(
        request,
        await deps.demo.getResetJob(
          await deps.actor(request, false),
          request.params.id,
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/demo/reset-jobs/:id/resume',
    async (request) =>
      response(
        request,
        await deps.demo.resumeReset(
          await deps.actor(request, true),
          request.params.id,
          DemoGuardSchema.parse(request.body),
          key(request),
        ),
      ),
  );
  app.get('/api/v1/demo/scenarios', async (request) => {
    await deps.actor(request, false);
    return response(request, await deps.demo.listScenarios());
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/demo/scenarios/:id/start',
    async (request, reply) =>
      reply.code(202).send(
        response(
          request,
          await (
            deps.scenarios?.start.bind(deps.scenarios) ??
            (() => {
              throw new AppError(
                'DEPENDENCY_UNAVAILABLE',
                '隔离旅程执行器尚未配置。',
              );
            })
          )(
            await deps.actor(request, true),
            request.params.id,
            StartDemoJourneySchema.parse(request.body),
            key(request),
          ),
        ),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/demo/scenario-runs/:id',
    async (request) => {
      if (!deps.scenarios)
        throw new AppError(
          'DEPENDENCY_UNAVAILABLE',
          '隔离旅程执行器尚未配置。',
        );
      return response(
        request,
        await deps.scenarios.get(
          await deps.actor(request, false),
          request.params.id,
        ),
      );
    },
  );
  app.put('/api/v1/demo/business-clock', async (request) =>
    response(
      request,
      await deps.demo.setBusinessClock(
        await deps.actor(request, true),
        DemoGuardSchema.extend({
          expected_version: z.number().int().positive(),
          business_now: z.iso.datetime(),
          timezone: z.string().min(1),
        }).parse(request.body),
        key(request),
      ),
    ),
  );
  app.post('/api/v1/demo/summary-triggers', async (request, reply) =>
    reply.code(202).send(
      response(
        request,
        await deps.demo.triggerSummary(
          await deps.actor(request, true),
          DemoGuardSchema.extend({
            subscription_id: z.string().min(1).optional(),
          }).parse(request.body),
          key(request),
        ),
      ),
    ),
  );
  app.get('/api/v1/demo/faults', async (request) =>
    response(
      request,
      await deps.demo.listFaults(await deps.actor(request, false)),
    ),
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/demo/summary-triggers/:id',
    async (request) =>
      response(
        request,
        await deps.demo.getSummaryTrigger(
          await deps.actor(request, false),
          request.params.id,
        ),
      ),
  );
  app.post('/api/v1/demo/faults', async (request, reply) =>
    reply
      .code(201)
      .send(
        response(
          request,
          await deps.demo.armFault(
            await deps.actor(request, true),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/demo/faults/:id/disable',
    async (request) =>
      response(
        request,
        await deps.demo.disableFault(
          await deps.actor(request, true),
          request.params.id,
          DemoGuardSchema.extend({
            expected_version: z.number().int().positive(),
          }).parse(request.body),
          key(request),
        ),
      ),
  );
}
