import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import {
  ConfirmInputSchema,
  PrepareInputSchema,
} from '@caixiaozhi/contracts/actions';
import type { ActionService } from '@caixiaozhi/action-service';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
type HttpIdentity = {
  requireActor(request: FastifyRequest): Promise<ActorContext>;
  assertCsrf(request: FastifyRequest): Promise<void>;
};
export type ApprovalQueryPort = {
  list(actor: ActorContext, query: unknown): Promise<unknown>;
  detail(actor: ActorContext, id: string): Promise<unknown>;
  history(actor: ActorContext, id: string, query: unknown): Promise<unknown>;
};
function id(request: FastifyRequest) {
  return z.strictObject({ id: z.string().min(1) }).parse(request.params).id;
}
function key(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200)
    throw new AppError(
      'VALIDATION_ERROR',
      '写请求需要有效的 Idempotency-Key。',
    );
  return value;
}
export function registerActionRoutes(
  app: FastifyInstance,
  deps: {
    actions: ActionService;
    identity: HttpIdentity;
    approvals?: ApprovalQueryPort;
  },
) {
  const { actions, identity } = deps;
  app.post('/api/v1/confirmations', async (request) => {
    await identity.assertCsrf(request);
    const actor = await identity.requireActor(request);
    const body = PrepareInputSchema.omit({
      idempotency_key: true,
      run_id: true,
      trace_id: true,
    }).parse(request.body);
    return dataResponse(
      request,
      await actions.prepareAction(actor, {
        ...body,
        idempotency_key: key(request),
        trace_id: request.id,
      }),
    );
  });
  app.get('/api/v1/confirmations/:id', async (request) =>
    dataResponse(
      request,
      await actions.getReview(
        await identity.requireActor(request),
        id(request),
        { channel: 'browser' },
      ),
    ),
  );
  app.post('/api/v1/confirmations/:id/confirm', async (request, reply) => {
    await identity.assertCsrf(request);
    key(request);
    const result = await actions.confirmAction(
      await identity.requireActor(request),
      id(request),
      ConfirmInputSchema.parse(request.body),
    );
    return reply
      .code(
        ['confirmed', 'executing', 'unknown'].includes(result.state)
          ? 202
          : 200,
      )
      .send(dataResponse(request, result));
  });
  app.get('/api/v1/actions/:id', async (request) =>
    dataResponse(
      request,
      await actions.getAction(
        await identity.requireActor(request),
        id(request),
      ),
    ),
  );
  for (const operation of ['cancel', 'reconcile'] as const)
    app.post(`/api/v1/actions/:id/${operation}`, async (request, reply) => {
      await identity.assertCsrf(request);
      key(request);
      const actor = await identity.requireActor(request),
        body = z
          .strictObject({ expected_version: z.number().int().positive() })
          .parse(request.body);
      let result;
      if (operation === 'cancel')
        result = await actions.cancelAction(
          actor,
          id(request),
          body.expected_version,
        );
      else {
        const current = await actions.getAction(actor, id(request));
        if (current.version !== body.expected_version)
          throw new AppError('VERSION_CONFLICT', '动作版本已变化。');
        result = await actions.reconcileAction(actor, current.id);
      }
      return reply
        .code(['executing', 'unknown'].includes(result.state) ? 202 : 200)
        .send(dataResponse(request, result));
    });
  if (deps.approvals) {
    const approvals = deps.approvals;
    app.get('/api/v1/approvals', async (request) =>
      dataResponse(
        request,
        await approvals.list(
          await identity.requireActor(request),
          request.query,
        ),
      ),
    );
    app.get('/api/v1/approvals/:id', async (request) =>
      dataResponse(
        request,
        await approvals.detail(
          await identity.requireActor(request),
          id(request),
        ),
      ),
    );
    app.get('/api/v1/approvals/:id/history', async (request) =>
      dataResponse(
        request,
        await approvals.history(
          await identity.requireActor(request),
          id(request),
          request.query,
        ),
      ),
    );
  }
}
