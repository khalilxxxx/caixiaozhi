import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { ActionService } from '@caixiaozhi/action-service';
import { AppError } from '@caixiaozhi/platform/errors';
import { dataResponse } from '../../http.js';
import type { IntegrationRegistry } from './registry.js';
type HttpIdentity = {
  requireActor(request: FastifyRequest): Promise<ActorContext>;
  assertCsrf(request: FastifyRequest): Promise<void>;
};
const id = (r: FastifyRequest) =>
  z.strictObject({ id: z.string().min(1) }).parse(r.params).id;
function key(r: FastifyRequest) {
  const k = r.headers['idempotency-key'];
  if (typeof k !== 'string' || !k || k.length > 200)
    throw new AppError('VALIDATION_ERROR', '写入请求需要 Idempotency-Key。');
  return k;
}
export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: {
    integrations: IntegrationRegistry;
    identity: HttpIdentity;
    actions?: ActionService;
  },
) {
  const { integrations, identity } = deps;
  app.get('/api/v1/integrations/connectors', async (r) =>
    dataResponse(
      r,
      await integrations.listConnectors(await identity.requireActor(r)),
    ),
  );
  app.get('/api/v1/integrations/capabilities', async (r) =>
    dataResponse(
      r,
      await integrations.listCapabilities(await identity.requireActor(r)),
    ),
  );
  app.get('/api/v1/integrations/invocations', async (r) =>
    dataResponse(
      r,
      await integrations.listInvocations(await identity.requireActor(r)),
    ),
  );
  app.post('/api/v1/integrations/connectors', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await integrations.createConnector(
        await identity.requireActor(r),
        r.body,
        key(r),
      ),
    );
  });
  app.patch('/api/v1/integrations/connectors/:id', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await integrations.updateConnector(
        await identity.requireActor(r),
        id(r),
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/integrations/connectors/:id/test', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await integrations.testConnector(
        await identity.requireActor(r),
        id(r),
        key(r),
      ),
    );
  });
  app.post('/api/v1/integrations/capabilities/:id/versions', async (r) => {
    await identity.assertCsrf(r);
    return dataResponse(
      r,
      await integrations.createVersion(
        await identity.requireActor(r),
        id(r),
        r.body,
        key(r),
      ),
    );
  });
  app.post('/api/v1/integrations/capabilities/:id/test', async (r) => {
    await identity.assertCsrf(r);
    key(r);
    const b = z.strictObject({ version_id: z.string().min(1) }).parse(r.body);
    return dataResponse(
      r,
      await integrations.testVersion(
        await identity.requireActor(r),
        id(r),
        b.version_id,
        key(r),
      ),
    );
  });
  for (const operation of ['publish', 'disable'] as const)
    app.post(
      `/api/v1/integrations/capabilities/:id/${operation}`,
      async (r) => {
        await identity.assertCsrf(r);
        const actor = await identity.requireActor(r),
          b = z
            .strictObject({
              version_id: z.string().min(1).optional(),
              expected_version: z.number().int().positive(),
              reason: z.string().min(1).max(1000).optional(),
            })
            .parse(r.body);
        if (!deps.actions)
          throw new AppError('INVALID_STATE', '统一确认动作服务尚未接入。');
        return dataResponse(
          r,
          await deps.actions.prepareAction(actor, {
            action:
              operation === 'publish'
                ? 'integration.capability.publish'
                : 'integration.capability.disable',
            resource_refs: [],
            args: { ...b, capability_id: id(r) },
            idempotency_key: key(r),
            trace_id: r.id,
          }),
        );
      },
    );
  // dispatchTool仅被可信runtime调用，不注册公网任意工具执行端点。
}
