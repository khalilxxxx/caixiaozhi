import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HttpIdentity } from '../identity/routes.js';
import type { DocumentService } from '@caixiaozhi/business-adapters/domain/documents';
import type { InvoiceService } from '@caixiaozhi/business-adapters/domain/invoices';
import type { TravelProposalService } from '@caixiaozhi/business-adapters/domain/proposals';
import type { ExpenseProposalService } from '@caixiaozhi/business-adapters/domain/expense-proposals';
import type { BusinessMessageService } from '@caixiaozhi/business-adapters/domain/messages';
import { validateSubmission } from '@caixiaozhi/business-adapters/domain/validation';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
const key = (request: FastifyRequest) => {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new AppError(
      'VALIDATION_ERROR',
      '写入请求需要有效的 Idempotency-Key。',
    );
  return value;
};
const id = (request: FastifyRequest) =>
  z.strictObject({ id: z.string().min(1) }).parse(request.params).id;
const querySchema = z.strictObject({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  state: z.string().optional(),
});
export function registerBusinessRoutes(
  app: FastifyInstance,
  deps: {
    documents: DocumentService;
    invoices: InvoiceService;
    proposals: TravelProposalService;
    expenseProposals?: ExpenseProposalService;
    messages: BusinessMessageService;
    identity: HttpIdentity;
  },
) {
  const { documents, invoices, proposals, messages, identity } = deps;
  const writeActor = async (request: FastifyRequest) => {
    await identity.assertCsrf(request);
    key(request);
    return identity.requireActor(request);
  };
  for (const [path, kind] of [
    ['travel', 'travel'],
    ['expenses/claims', 'expense_claim'],
    ['oa/entertainment', 'oa_request'],
  ] as const) {
    app.get(`/api/v1/${path}`, async (request) =>
      dataResponse(
        request,
        await documents.list(
          await identity.requireActor(request),
          kind,
          querySchema.parse(request.query),
        ),
      ),
    );
    app.post(`/api/v1/${path}`, async (request, reply) =>
      reply
        .code(201)
        .send(
          dataResponse(
            request,
            await documents.create(
              await writeActor(request),
              kind,
              request.body,
              key(request),
            ),
          ),
        ),
    );
    app.get(`/api/v1/${path}/:id`, async (request) =>
      dataResponse(
        request,
        await documents.get(
          await identity.requireActor(request),
          kind,
          id(request),
        ),
      ),
    );
    app.patch(`/api/v1/${path}/:id`, async (request) => {
      const actor = await writeActor(request),
        resourceId = id(request);
      const result =
        kind === 'travel'
          ? await documents.saveTravel(
              actor,
              resourceId,
              request.body,
              key(request),
            )
          : kind === 'expense_claim'
            ? await documents.saveExpense(
                actor,
                resourceId,
                request.body,
                key(request),
              )
            : await documents.saveOa(
                actor,
                resourceId,
                request.body,
                key(request),
              );
      return dataResponse(request, result);
    });
    app.get(`/api/v1/${path}/:id/validation`, async (request) => {
      const actor = await identity.requireActor(request),
        document = await documents.get(actor, kind, id(request));
      return dataResponse(
        request,
        await validateSubmission(documents, actor, {
          type: kind,
          id: document.id,
          version: document.version,
        }),
      );
    });
  }
  app.post('/api/v1/travel/:id/proposals', async (request, reply) =>
    reply
      .code(202)
      .send(
        dataResponse(
          request,
          await proposals.create(
            await writeActor(request),
            id(request),
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.get('/api/v1/travel/:travelId/proposals/:proposalId', async (request) => {
    const params = z
      .strictObject({ travelId: z.string(), proposalId: z.string() })
      .parse(request.params);
    return dataResponse(
      request,
      await proposals.get(
        await identity.requireActor(request),
        params.travelId,
        params.proposalId,
      ),
    );
  });
  app.post(
    '/api/v1/travel/:travelId/proposals/:proposalId/apply',
    async (request) => {
      const params = z
        .strictObject({ travelId: z.string(), proposalId: z.string() })
        .parse(request.params);
      return dataResponse(
        request,
        await proposals.apply(
          await writeActor(request),
          params.travelId,
          params.proposalId,
          request.body,
          key(request),
        ),
      );
    },
  );
  app.get('/api/v1/expenses/invoices', async (request) =>
    dataResponse(
      request,
      await invoices.list(
        await identity.requireActor(request),
        querySchema.omit({ state: true }).parse(request.query),
      ),
    ),
  );
  app.get('/api/v1/expenses/invoices/:id', async (request) =>
    dataResponse(
      request,
      await invoices.get(await identity.requireActor(request), id(request)),
    ),
  );
  app.post('/api/v1/expenses/invoices/:id/confirm', async (request) =>
    dataResponse(
      request,
      await invoices.confirm(
        await writeActor(request),
        id(request),
        request.body,
        key(request),
      ),
    ),
  );
  app.patch('/api/v1/expenses/invoices/:id', async (request) =>
    dataResponse(
      request,
      await invoices.patch(
        await writeActor(request),
        id(request),
        request.body,
        key(request),
      ),
    ),
  );
  if (deps.expenseProposals) {
    const expenseProposals = deps.expenseProposals;
    app.post('/api/v1/expenses/claims/:id/proposals', async (request, reply) =>
      reply
        .code(202)
        .send(
          dataResponse(
            request,
            await expenseProposals.create(
              await writeActor(request),
              id(request),
              request.body,
              key(request),
            ),
          ),
        ),
    );
    app.get(
      '/api/v1/expenses/claims/:claimId/proposals/:proposalId',
      async (request) => {
        const params = z
          .strictObject({ claimId: z.string(), proposalId: z.string() })
          .parse(request.params);
        return dataResponse(
          request,
          await expenseProposals.get(
            await identity.requireActor(request),
            params.claimId,
            params.proposalId,
          ),
        );
      },
    );
    app.post(
      '/api/v1/expenses/claims/:claimId/proposals/:proposalId/apply',
      async (request) => {
        const params = z
          .strictObject({ claimId: z.string(), proposalId: z.string() })
          .parse(request.params);
        return dataResponse(
          request,
          await expenseProposals.apply(
            await writeActor(request),
            params.claimId,
            params.proposalId,
            request.body,
            key(request),
          ),
        );
      },
    );
  }
  const fileInput = z.strictObject({
    file_id: z.string().min(1),
    file_version: z.number().int().positive(),
  });
  app.post('/api/v1/expenses/ocr-tasks', async (request, reply) =>
    reply
      .code(202)
      .send(
        dataResponse(
          request,
          await invoices.createOcr(
            await writeActor(request),
            fileInput.parse(request.body),
            key(request),
          ),
        ),
      ),
  );
  app.get('/api/v1/expenses/ocr-tasks/:id', async (request) =>
    dataResponse(
      request,
      await invoices.getTask(await identity.requireActor(request), id(request)),
    ),
  );
  app.post('/api/v1/expenses/invoices/manual', async (request, reply) =>
    reply
      .code(201)
      .send(
        dataResponse(
          request,
          await invoices.createManual(
            await writeActor(request),
            fileInput.parse(request.body),
            key(request),
          ),
        ),
      ),
  );
  app.get('/api/v1/oa/messages', async (request) => {
    const query = z
      .strictObject({ box: z.enum(['inbox', 'sent']).default('inbox') })
      .parse(request.query);
    return dataResponse(
      request,
      await messages.list(await identity.requireActor(request), query.box),
    );
  });
  app.post('/api/v1/oa/messages', async (request, reply) =>
    reply
      .code(201)
      .send(
        dataResponse(
          request,
          await messages.save(
            await writeActor(request),
            null,
            request.body,
            key(request),
          ),
        ),
      ),
  );
  app.patch('/api/v1/oa/messages/:id', async (request) =>
    dataResponse(
      request,
      await messages.save(
        await writeActor(request),
        id(request),
        request.body,
        key(request),
      ),
    ),
  );
  app.post('/api/v1/oa/messages/:id/read', async (request) => {
    const body = z
      .strictObject({ expected_version: z.number().int().positive() })
      .parse(request.body);
    return dataResponse(
      request,
      await messages.markRead(
        await writeActor(request),
        id(request),
        body.expected_version,
        key(request),
      ),
    );
  });
}
