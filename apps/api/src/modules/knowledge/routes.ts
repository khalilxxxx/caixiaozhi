import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  KnowledgeSearchSchema,
  KnowledgeQuestionInputSchema,
  PolicyDraftSchema,
} from '@caixiaozhi/contracts/knowledge';
import type { FinanceService } from '@caixiaozhi/finance';
import type { HttpIdentity } from '../identity/routes.js';
import { dataResponse } from '../../http.js';
const id = (params: unknown) =>
  z.strictObject({ id: z.string().min(1) }).parse(params).id;
const key = (headers: Record<string, unknown>) =>
  z.string().min(1).max(200).parse(headers['idempotency-key']);
export function registerKnowledgeRoutes(
  app: FastifyInstance,
  deps: {
    finance: FinanceService;
    identity: HttpIdentity;
    dataMode?: 'demo' | 'production';
  },
) {
  const mode = deps.dataMode ?? 'demo',
    service = deps.finance.knowledge;
  app.get('/api/v1/knowledge/policies', async (request) =>
    dataResponse(
      request,
      await service.listPolicies(await deps.identity.requireActor(request)),
      mode,
    ),
  );
  app.post('/api/v1/knowledge/policies', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    reply.code(202);
    return dataResponse(
      request,
      await service.createPolicyDraft(
        actor,
        PolicyDraftSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.get('/api/v1/knowledge/imports/:id', async (request) =>
    dataResponse(
      request,
      await service.getImport(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/knowledge/search', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    return dataResponse(
      request,
      await service.searchAuthorized(
        actor,
        KnowledgeSearchSchema.parse(request.body),
      ),
      mode,
    );
  });
  app.get('/api/v1/knowledge/citations/:id', async (request) =>
    dataResponse(
      request,
      await service.getCitation(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/knowledge/questions', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const { origin_run_id, ...input } = KnowledgeQuestionInputSchema.parse(
      request.body,
    );
    return dataResponse(
      request,
      await service.question(actor, input, origin_run_id, key(request.headers)),
      mode,
    );
  });
  app.get('/api/v1/knowledge/questions/:id', async (request) =>
    dataResponse(
      request,
      await service.getQuestion(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.post('/api/v1/knowledge/feedback', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const input = z
      .strictObject({
        answer_id: z.string().min(1),
        kind: z.enum(['helpful', 'incorrect', 'outdated', 'missing_context']),
        comment: z.string().max(2000).optional(),
        citation_id: z.string().optional(),
      })
      .parse(request.body);
    return dataResponse(
      request,
      await service.addFeedback(actor, input, key(request.headers)),
      mode,
    );
  });
  app.post('/api/v1/knowledge/clarifications', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    const input = z
      .strictObject({
        question_id: z.string().min(1),
        reason: z.string().min(1).max(500),
        comment: z.string().max(2000).optional(),
      })
      .parse(request.body);
    return dataResponse(
      request,
      await service.addClarification(actor, input, key(request.headers)),
      mode,
    );
  });
}
