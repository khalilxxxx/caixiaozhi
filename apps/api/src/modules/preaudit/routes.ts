import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StartPreauditSchema } from '@caixiaozhi/contracts/preaudit';
import type { FinanceService } from '@caixiaozhi/finance';
import type { HttpIdentity } from '../identity/routes.js';
import { dataResponse } from '../../http.js';
const id = (params: unknown) =>
  z.strictObject({ id: z.string().min(1) }).parse(params).id;
const key = (headers: Record<string, unknown>) =>
  z.string().min(1).max(200).parse(headers['idempotency-key']);
export function registerPreauditRoutes(
  app: FastifyInstance,
  deps: {
    finance: FinanceService;
    identity: HttpIdentity;
    dataMode?: 'demo' | 'production';
  },
) {
  const mode = deps.dataMode ?? 'demo',
    service = deps.finance.preaudit;
  app.post('/api/v1/preaudit/tasks', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    reply.code(202);
    return dataResponse(
      request,
      await service.startPreaudit(
        actor,
        StartPreauditSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.get('/api/v1/preaudit/tasks/:id', async (request) =>
    dataResponse(
      request,
      await service.getTask(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.get('/api/v1/preaudit/results/:id', async (request) =>
    dataResponse(
      request,
      await service.getResult(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.get('/api/v1/preaudit/tasks/:id/bulk-candidates', async (request) =>
    dataResponse(
      request,
      await service.bulkCandidates(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/preaudit/tasks/:id/cancel', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const input = z
      .strictObject({ expected_version: z.number().int().positive() })
      .parse(request.body);
    reply.code(202);
    return dataResponse(
      request,
      await service.cancelTask(
        actor,
        id(request.params),
        input.expected_version,
        key(request.headers),
      ),
      mode,
    );
  });
  app.post('/api/v1/preaudit/tasks/:id/retry', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const input = z
      .strictObject({
        expected_version: z.number().int().positive(),
        failed_item_ids: z.array(z.string().min(1)).min(1).max(100),
      })
      .parse(request.body);
    reply.code(202);
    return dataResponse(
      request,
      await service.retryTask(
        actor,
        id(request.params),
        input.expected_version,
        input.failed_item_ids,
        key(request.headers),
      ),
      mode,
    );
  });
}
