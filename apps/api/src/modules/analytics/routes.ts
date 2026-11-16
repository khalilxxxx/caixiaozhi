import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { AnalyticsService } from '@caixiaozhi/insights/analytics';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
type Identity = {
  requireActor(r: FastifyRequest): Promise<ActorContext>;
  assertCsrf(r: FastifyRequest): Promise<void>;
};
const id = (r: FastifyRequest) =>
  z.strictObject({ id: z.string().min(1) }).parse(r.params).id;
const key = (r: FastifyRequest) => {
  const k = r.headers['idempotency-key'];
  if (typeof k !== 'string' || !k)
    throw new AppError('VALIDATION_ERROR', '写请求需要 Idempotency-Key。');
  return k;
};
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: { analytics: AnalyticsService; identity: Identity },
) {
  const { analytics, identity } = deps;
  app.get('/api/v1/analytics/catalog', async (r) =>
    dataResponse(r, await analytics.getCatalog(await identity.requireActor(r))),
  );
  app.post('/api/v1/analytics/queries', async (r, reply) => {
    await identity.assertCsrf(r);
    return reply
      .code(202)
      .send(
        dataResponse(
          r,
          await analytics.query(await identity.requireActor(r), r.body, key(r)),
        ),
      );
  });
  app.get('/api/v1/analytics/queries/:id', async (r) =>
    dataResponse(
      r,
      await analytics.getQuery(await identity.requireActor(r), id(r)),
    ),
  );
  app.get('/api/v1/analytics/snapshots/:id', async (r) =>
    dataResponse(
      r,
      await analytics.getSnapshot(await identity.requireActor(r), id(r)),
    ),
  );
  app.get('/api/v1/analytics/snapshots/:id/rows', async (r) =>
    dataResponse(
      r,
      await analytics.drillSnapshot(
        await identity.requireActor(r),
        id(r),
        r.query,
      ),
    ),
  );
  app.post('/api/v1/analytics/snapshots/:id/refresh', async (r, reply) => {
    await identity.assertCsrf(r);
    const b = z
      .strictObject({ expected_version: z.number().int().positive() })
      .parse(r.body);
    return reply
      .code(202)
      .send(
        dataResponse(
          r,
          await analytics.refreshSnapshot(
            await identity.requireActor(r),
            id(r),
            b.expected_version,
            key(r),
          ),
        ),
      );
  });
  app.post('/api/v1/analytics/reports', async (r, reply) => {
    await identity.assertCsrf(r);
    return reply
      .code(202)
      .send(
        dataResponse(
          r,
          await analytics.createReport(
            await identity.requireActor(r),
            r.body,
            key(r),
          ),
        ),
      );
  });
  app.get('/api/v1/analytics/reports/:id', async (r) =>
    dataResponse(
      r,
      await analytics.getReport(await identity.requireActor(r), id(r)),
    ),
  );
  app.patch('/api/v1/analytics/reports/:id/draft', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await analytics.patchReport(
        await identity.requireActor(r),
        id(r),
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/analytics/reports/:id/exports', async (r, reply) => {
    await identity.assertCsrf(r);
    return reply
      .code(202)
      .send(
        dataResponse(
          r,
          await analytics.exportReport(
            await identity.requireActor(r),
            id(r),
            r.body,
            key(r),
          ),
        ),
      );
  });
  app.get('/api/v1/analytics/artifacts/:id', async (r) =>
    dataResponse(
      r,
      await analytics.getArtifact(await identity.requireActor(r), id(r)),
    ),
  );
  app.get('/api/v1/analytics/artifacts/:id/download', async (r, reply) => {
    const data = await analytics.downloadArtifact(
      await identity.requireActor(r),
      id(r),
    );
    return reply
      .header('Content-Type', data.content_type)
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(data.filename)}`,
      )
      .header('Cache-Control', 'private, no-store')
      .send(Buffer.from(data.bytes));
  });
}
