import type { FastifyRequest } from 'fastify';
import type { ConfiguredApplication } from '@caixiaozhi/application/demo';
import type { AppConfig } from '@caixiaozhi/platform/config';
import { z } from 'zod';
import { AppError } from '@caixiaozhi/platform/errors';
import { createApp } from './app.js';
import { dataResponse } from './http.js';
import {
  registerIdentityRoutes,
  createIdentityHttpContext,
} from './modules/identity/routes.js';
import { registerFileRoutes } from './modules/files/routes.js';
import { registerBusinessRoutes } from './modules/business/routes.js';
import { registerActionRoutes } from './modules/approvals/routes.js';
import { registerIntegrationRoutes } from './modules/integrations/routes.js';
import { registerKnowledgeRoutes } from './modules/knowledge/routes.js';
import { registerRuleRoutes } from './modules/rules/routes.js';
import { registerPreauditRoutes } from './modules/preaudit/routes.js';
import { registerAnalyticsRoutes } from './modules/analytics/routes.js';
import { registerSkillRoutes } from './modules/skills/routes.js';
import { registerRunRoutes } from './modules/runs/routes.js';
import { registerAssistantRoutes } from './modules/assistant/routes.js';
import { registerMemoryRoutes } from './modules/memory/routes.js';
import { registerDemoRoutes } from './modules/demo/routes.js';
import { registerOperationsRoutes } from './modules/operations/routes.js';

export function createProductApp(
  config: AppConfig,
  services: ConfiguredApplication,
  checks: { database: () => Promise<void>; storage: () => Promise<void> },
) {
  const app = createApp({
    ...checks,
    dataMode: config.appMode === 'production' ? 'production' : 'demo',
    logLevel: config.logLevel,
  });
  const identityOptions = {
    identity: services.identity,
    appMode: config.appMode,
    cookieSecure: config.cookieSecure,
    allowedOrigins: [config.appOrigin],
  };
  const rawIdentity = createIdentityHttpContext(
    services.identity,
    identityOptions,
  );
  const httpIdentity = {
    ...rawIdentity,
    requireActor: async (request: FastifyRequest) =>
      services.freshActor(await rawIdentity.requireActor(request)),
  };
  const actor = async (request: FastifyRequest, write: boolean) => {
    if (write) await httpIdentity.assertCsrf(request);
    return httpIdentity.requireActor(request);
  };
  const controlActor = async (request: FastifyRequest, write: boolean) => {
    if (write) await rawIdentity.assertCsrf(request);
    return rawIdentity.requireActor(request);
  };
  registerIdentityRoutes(app, {
    ...identityOptions,
    demoAccessGate: async (_request, input) => {
      const environmentId =
        input.demo_environment_id ?? services.demoEnvironmentId;
      if (environmentId !== services.demoEnvironmentId)
        throw new AppError('NOT_FOUND', '演示环境不存在或未开放当前入口。');
      const env = await services.demo.gate.currentTenant(environmentId);
      if (input.generation !== undefined && input.generation !== env.generation)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '演示环境已更新，请刷新身份列表。',
        );
      return {
        tenantId: env.tenant_id,
        environmentId,
        generation: env.generation,
      };
    },
  });
  const dataMode =
    config.appMode === 'production'
      ? ('production' as const)
      : ('demo' as const);
  registerFileRoutes(app, {
    files: services.files,
    identity: httpIdentity,
    dataMode,
  });
  registerBusinessRoutes(app, { ...services, identity: httpIdentity });
  registerActionRoutes(app, {
    actions: services.actions,
    identity: rawIdentity,
    approvals: {
      list: (actor, query) =>
        services.approvals.list(
          actor,
          z
            .strictObject({
              cursor: z.string().optional(),
              limit: z.coerce.number().int().min(1).max(100).optional(),
            })
            .parse(query),
        ),
      detail: (actor, id) => services.approvals.detail(actor, id),
      history: (actor, id, query) =>
        services.approvals.history(actor, id, query),
    },
  });
  registerIntegrationRoutes(app, {
    integrations: services.integrations,
    actions: services.actions,
    identity: httpIdentity,
  });
  registerKnowledgeRoutes(app, {
    finance: services.finance,
    identity: httpIdentity,
    dataMode,
  });
  registerRuleRoutes(app, {
    finance: services.finance,
    identity: httpIdentity,
    dataMode,
  });
  registerPreauditRoutes(app, {
    finance: services.finance,
    identity: httpIdentity,
    dataMode,
  });
  registerAnalyticsRoutes(app, {
    analytics: services.analytics,
    identity: httpIdentity,
  });
  registerSkillRoutes(app, { skills: services.skills, identity: httpIdentity });
  registerRunRoutes(app, {
    runs: services.runs,
    actor,
    dataMode,
    disconnectAfterEvent: (actor, id) =>
      services.faults?.disconnectSse({
        tenant_id: actor.tenant_id,
        resource_ids: [actor.user_id, id],
      }) ?? Promise.resolve(false),
  });
  registerAssistantRoutes(app, {
    assistant: services.assistant,
    actor,
    dataMode,
  });
  registerMemoryRoutes(app, { memory: services.memory, actor, dataMode });
  registerDemoRoutes(app, {
    demo: services.demo,
    scenarios: services.scenarios,
    appMode: config.appMode,
    actor: controlActor,
  });
  registerOperationsRoutes(app, {
    services,
    database: services.documents.database,
    identity: httpIdentity,
  });
  app.get<{ Params: { runId: string; id: string } }>(
    '/api/v1/runs/:runId/artifacts/:id',
    async (request, reply) => {
      const artifact = await services.toolArtifacts.download(
        await httpIdentity.requireActor(request),
        request.params.runId,
        z.uuid().parse(request.params.id),
      );
      reply
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .header(
          'content-disposition',
          `attachment; filename="${artifact.id}.json"`,
        )
        .type('application/json');
      return reply.send(Buffer.from(artifact.bytes));
    },
  );
  app.get<{ Params: { id: string } }>(
    '/api/v1/model-tasks/:id',
    async (request) =>
      dataResponse(
        request,
        await services.generation.getTask(
          await httpIdentity.requireActor(request),
          request.params.id,
        ),
      ),
  );
  app.get('/api/v1/operations/status', async (request) => {
    const current = await httpIdentity.requireActor(request);
    await services.identity.assertPermission(current, 'operations.read');
    return dataResponse(request, {
      dsh: {
        sdk_version: '0.2.2-rc.1',
        profile_version: 'finance-sdk-v1',
        model_configured: Boolean(
          config.dsh.apiKey &&
          config.dsh.baseURL &&
          config.dsh.model &&
          config.dsh.contextWindow,
        ),
      },
      data_mode: config.appMode === 'production' ? 'production' : 'demo',
    });
  });
  return app;
}
