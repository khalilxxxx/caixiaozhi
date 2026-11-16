import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { SkillService } from '@caixiaozhi/insights/skills';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
type Identity = {
  requireActor(r: FastifyRequest): Promise<ActorContext>;
  assertCsrf(r: FastifyRequest): Promise<void>;
};
const params = (r: FastifyRequest) =>
  z
    .object({
      id: z.string().min(1),
      versionId: z.string().optional(),
      validationId: z.string().optional(),
      reviewId: z.string().optional(),
    })
    .parse(r.params);
const key = (r: FastifyRequest) => {
  const k = r.headers['idempotency-key'];
  if (typeof k !== 'string' || !k)
    throw new AppError('VALIDATION_ERROR', '写请求需要 Idempotency-Key。');
  return k;
};
export function registerSkillRoutes(
  app: FastifyInstance,
  deps: { skills: SkillService; identity: Identity },
) {
  const { skills, identity } = deps;
  app.get('/api/v1/skills', async (r) =>
    dataResponse(
      r,
      await skills.listVisibleSkills(await identity.requireActor(r), r.query),
    ),
  );
  app.get('/api/v1/skills/reviews', async (r) =>
    dataResponse(
      r,
      await skills.listReviewTasks(await identity.requireActor(r)),
    ),
  );
  app.get('/api/v1/skills/:id', async (r) => {
    const q = z
      .strictObject({ version_id: z.string().optional() })
      .parse(r.query);
    return dataResponse(
      r,
      await skills.getSkill(
        await identity.requireActor(r),
        params(r).id,
        q.version_id,
      ),
    );
  });
  app.get('/api/v1/skills/:id/versions/:versionId/source', async (r) => {
    const p = params(r);
    return dataResponse(
      r,
      await skills.getSkillSource(
        await identity.requireActor(r),
        p.id,
        p.versionId!,
      ),
    );
  });
  app.post('/api/v1/skills', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.createSkill(await identity.requireActor(r), r.body, key(r)),
    );
  });
  app.post('/api/v1/skills/:id/versions', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.saveVersion(
        await identity.requireActor(r),
        params(r).id,
        r.body,
        key(r),
      ),
    );
  });
  app.post(
    '/api/v1/skills/:id/versions/:versionId/validate',
    async (r, reply) => {
      await identity.assertCsrf(r);
      const p = params(r);
      return reply
        .code(202)
        .send(
          dataResponse(
            r,
            await skills.validateVersion(
              await identity.requireActor(r),
              p.id,
              p.versionId!,
              r.body,
              key(r),
            ),
          ),
        );
    },
  );
  app.get('/api/v1/skills/:id/validations/:validationId', async (r) => {
    const p = params(r);
    return dataResponse(
      r,
      await skills.getValidation(
        await identity.requireActor(r),
        p.id,
        p.validationId!,
      ),
    );
  });
  app.post('/api/v1/skills/:id/activate', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.activatePersonalVersion(
        await identity.requireActor(r),
        params(r).id,
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/skills/resolve', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.resolve(await identity.requireActor(r), r.body),
    );
  });
  app.post('/api/v1/skills/:id/reviews', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.requestReview(
        await identity.requireActor(r),
        params(r).id,
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/skills/:id/reviews/:reviewId/decide', async (r) => {
    await identity.assertCsrf(r);
    const p = params(r);
    return dataResponse(
      r,
      await skills.decideReview(
        await identity.requireActor(r),
        p.id,
        p.reviewId!,
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/skills/:id/publication-intents', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.preparePublication(
        await identity.requireActor(r),
        params(r).id,
        r.body,
        key(r),
      ),
    );
  });
  for (const operation of ['disable', 'enable', 'archive'] as const)
    app.post(`/api/v1/skills/:id/${operation}`, async (r) => {
      await identity.assertCsrf(r);
      return dataResponse(
        r,
        await skills[operation](
          await identity.requireActor(r),
          params(r).id,
          r.body,
          key(r),
        ),
      );
    });
  app.patch('/api/v1/skills/:id/grants', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await skills.patchGrants(
        await identity.requireActor(r),
        params(r).id,
        r.body,
        key(r),
      ),
    );
  });
  app.get('/api/v1/skills/:id/invocations', async (r) =>
    dataResponse(
      r,
      await skills.listInvocations(
        await identity.requireActor(r),
        params(r).id,
      ),
    ),
  );
}
