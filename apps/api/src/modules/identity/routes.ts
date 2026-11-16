import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActorContext } from '@caixiaozhi/contracts/common';
import {
  DemoLoginInputSchema,
  DemoSwitchInputSchema,
  GrantChangeSchema,
} from '@caixiaozhi/contracts/identity';
import { AppError } from '@caixiaozhi/platform/errors';
import type { IdentityService } from '@caixiaozhi/identity';
import { DEMO_IDENTITIES, DEMO_DEPARTMENTS } from '@caixiaozhi/identity';
import { dataResponse } from '../../http.js';

export const SECURE_SESSION_COOKIE = '__Host-caixiaozhi_session';
export const DEVELOPMENT_SESSION_COOKIE = 'caixiaozhi_session';
export type DemoAccess = {
  tenantId: string;
  environmentId: string;
  generation: number;
};
export type DemoAccessGate = (
  request: FastifyRequest,
  input: { demo_environment_id?: string; generation?: number },
) => Promise<DemoAccess>;
export type HttpIdentity = {
  requireActor(request: FastifyRequest): Promise<ActorContext>;
  assertCsrf(request: FastifyRequest): Promise<void>;
};
type HttpIdentityOptions = {
  appMode: 'demo' | 'test' | 'production';
  cookieSecure?: boolean;
  allowedOrigins?: string[];
};

function cookieValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  if (values.length > 1)
    throw new AppError('UNAUTHENTICATED', '会话校验失败，请重新登录。');
  return values[0]?.slice(name.length + 1);
}
function optionsFor(options: HttpIdentityOptions) {
  const secure = options.cookieSecure ?? true;
  if (options.appMode === 'production' && !secure)
    throw new Error('生产会话必须启用 Secure Cookie。');
  return {
    secure,
    name: secure ? SECURE_SESSION_COOKIE : DEVELOPMENT_SESSION_COOKIE,
  };
}
function assertOrigin(request: FastifyRequest, allowedOrigins: string[] = []) {
  const origin = request.headers.origin;
  const ownOrigin = `${request.protocol}://${request.headers.host}`;
  let accepted = false;
  try {
    accepted =
      typeof origin === 'string' &&
      new URL(origin).origin === origin &&
      [ownOrigin, ...allowedOrigins].some(
        (allowed) => new URL(allowed).origin === origin,
      );
  } catch {
    accepted = false;
  }
  if (!accepted)
    throw new AppError('FORBIDDEN', '请求来源校验失败，请从当前应用页面重试。');
}
function sessionToken(request: FastifyRequest, name: string) {
  const token = cookieValue(request, name);
  if (!token) throw new AppError('UNAUTHENTICATED', '请先登录后再操作。');
  return token;
}
function idempotencyKey(request: FastifyRequest) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 200)
    throw new AppError(
      'VALIDATION_ERROR',
      '写入请求需要有效的 Idempotency-Key。',
    );
  return key;
}
const QuerySchema = z
  .object({
    q: z.string().max(100).optional(),
    department_id: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const BusinessDateSchema = z.strictObject({ business_date: z.iso.date() });

export function createIdentityHttpContext(
  identity: IdentityService,
  options: HttpIdentityOptions,
): HttpIdentity {
  const { name } = optionsFor(options);
  return {
    requireActor: (request) => identity.getActor(sessionToken(request, name)),
    assertCsrf: async (request) => {
      assertOrigin(request, options.allowedOrigins);
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !csrf)
        throw new AppError('FORBIDDEN', '请求缺少校验凭据，请刷新页面后重试。');
      await identity.validateCsrf(sessionToken(request, name), csrf);
    },
  };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: HttpIdentityOptions & {
    identity: IdentityService;
    demoAccessGate?: DemoAccessGate;
  },
) {
  const { identity } = deps;
  const http = createIdentityHttpContext(identity, deps);
  const { secure, name } = optionsFor(deps);
  const mode = deps.appMode === 'production' ? 'production' : 'demo';
  const setSession = (reply: FastifyReply, token: string, expires: string) =>
    reply.header(
      'set-cookie',
      `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}Expires=${new Date(expires).toUTCString()}`,
    );
  const noStore = (reply: FastifyReply) =>
    reply.header('cache-control', 'no-store');
  const csrfForRevoked = async (request: FastifyRequest) => {
    assertOrigin(request, deps.allowedOrigins);
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string')
      throw new AppError('FORBIDDEN', '请求缺少校验凭据，请刷新页面后重试。');
    const token = sessionToken(request, name);
    await identity.validateCsrf(token, csrf, true);
    return token;
  };
  if (
    deps.appMode === 'demo' &&
    deps.demoAccessGate &&
    identity.options.demoAccessEnabled
  ) {
    const gate = deps.demoAccessGate;
    app.get('/api/v1/auth/demo/identities', async (request, reply) => {
      const query = z
        .strictObject({
          demo_environment_id: z.string().optional(),
          generation: z.coerce.number().int().positive().optional(),
        })
        .parse(request.query);
      const access = await gate(request, query);
      noStore(reply);
      return dataResponse(
        request,
        {
          demo_environment_id: access.environmentId,
          generation: access.generation,
          identities: DEMO_IDENTITIES.map((person) => ({
            id: person.id,
            display_name: person.name,
            department_id: person.departmentId,
            department_name: DEMO_DEPARTMENTS.find(
              (d) => d.id === person.departmentId,
            )!.name,
            roles: person.roles,
            position: person.position,
          })),
        },
        mode,
      );
    });
    app.post('/api/v1/auth/demo/login', async (request, reply) => {
      assertOrigin(request, deps.allowedOrigins);
      const key = idempotencyKey(request);
      const input = DemoLoginInputSchema.parse(request.body);
      const access = await gate(request, input);
      if (
        input.generation !== access.generation ||
        input.demo_environment_id !== access.environmentId
      )
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '演示环境已更新，请刷新身份列表。',
        );
      const session = await identity.loginDemo(
        input.selected_user_id,
        cookieValue(request, name),
        access,
        { key, operation: 'login' },
      );
      setSession(reply, session.session_token, session.expires_at);
      noStore(reply);
      return dataResponse(
        request,
        {
          ...session.me,
          expires_at: session.expires_at,
          cache_invalidated: session.cache_invalidated,
        },
        mode,
      );
    });
    app.post('/api/v1/auth/demo/switch', async (request, reply) => {
      const key = idempotencyKey(request);
      const input = DemoSwitchInputSchema.parse(request.body);
      const token = await csrfForRevoked(request);
      const access = await gate(request, input);
      if (input.generation !== access.generation)
        throw new AppError(
          'REVALIDATION_REQUIRED',
          '演示环境已更新，请刷新身份列表。',
        );
      const session = await identity.loginDemo(
        input.selected_user_id,
        token,
        access,
        { key, operation: 'switch' },
      );
      setSession(reply, session.session_token, session.expires_at);
      noStore(reply);
      return dataResponse(
        request,
        {
          ...session.me,
          expires_at: session.expires_at,
          cache_invalidated: true,
        },
        mode,
      );
    });
  }
  app.post('/api/v1/auth/logout', async (request, reply) => {
    assertOrigin(request, deps.allowedOrigins);
    idempotencyKey(request);
    if (cookieValue(request, name)) {
      const token = await csrfForRevoked(request);
      await identity.logout(token);
    }
    reply.header(
      'set-cookie',
      `${name}=; Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}Max-Age=0`,
    );
    noStore(reply);
    return dataResponse(
      request,
      { logged_out: true, cache_invalidated: true },
      mode,
    );
  });
  app.get('/api/v1/me', async (request, reply) => {
    noStore(reply);
    return dataResponse(
      request,
      await identity.getMe(await http.requireActor(request)),
      mode,
    );
  });
  app.get('/api/v1/auth/grants/me', async (request, reply) => {
    noStore(reply);
    return dataResponse(
      request,
      { items: await identity.listMyGrants(await http.requireActor(request)) },
      mode,
    );
  });
  app.put('/api/v1/auth/grants/:subjectId', async (request) => {
    const actor = await http.requireActor(request);
    await http.assertCsrf(request);
    idempotencyKey(request);
    await identity.assertPermission(actor, 'identity.grant.manage');
    const { subjectId } = z
      .strictObject({ subjectId: z.string().min(1) })
      .parse(request.params);
    const input = GrantChangeSchema.parse(request.body);
    return dataResponse(
      request,
      await identity.replaceGrants(actor, {
        tenantId: actor.tenant_id,
        targetUserId: subjectId,
        expectedVersion: input.expected_version,
        grants: input.grants,
        reason: input.reason,
        traceId: request.id,
      }),
      mode,
    );
  });
  app.get('/api/v1/directory/people', async (request) =>
    dataResponse(
      request,
      await identity.searchPeople(
        await http.requireActor(request),
        QuerySchema.parse(request.query),
      ),
      mode,
    ),
  );
  app.get('/api/v1/directory/departments', async (request) =>
    dataResponse(
      request,
      await identity.listDepartments(
        await http.requireActor(request),
        QuerySchema.omit({ department_id: true }).parse(request.query),
      ),
      mode,
    ),
  );
  app.get('/api/v1/directory/groups', async (request) =>
    dataResponse(
      request,
      await identity.listGroups(
        await http.requireActor(request),
        QuerySchema.omit({ department_id: true }).parse(request.query),
      ),
      mode,
    ),
  );
  app.get('/api/v1/master-data/cost-centers', async (request) =>
    dataResponse(
      request,
      {
        items: await identity.listCostCenters(
          await http.requireActor(request),
          BusinessDateSchema.parse(request.query).business_date,
        ),
      },
      mode,
    ),
  );
  app.get('/api/v1/master-data/projects', async (request) =>
    dataResponse(
      request,
      {
        items: await identity.listProjects(
          await http.requireActor(request),
          BusinessDateSchema.parse(request.query).business_date,
        ),
      },
      mode,
    ),
  );
  app.get('/api/v1/master-data/places/resolve', async (request) =>
    dataResponse(
      request,
      await identity.resolvePlace(
        await http.requireActor(request),
        z.strictObject({ q: z.string().min(1).max(100) }).parse(request.query)
          .q,
      ),
      mode,
    ),
  );
  return http;
}
