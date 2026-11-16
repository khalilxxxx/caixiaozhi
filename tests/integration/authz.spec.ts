import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createApp } from '../../apps/api/src/app.js';
import { registerIdentityRoutes } from '../../apps/api/src/modules/identity/routes.js';

const database = createDatabase(loadConfig().databaseUrl);
const tenantId = `identity-${randomUUID()}`;
const options = {
  sessionSecret: 'test-only-session-secret-at-least-32-characters',
  appMode: 'demo' as const,
  demoAccessEnabled: true,
};
const identity = createIdentityService(database, options);
const login = (user: string) =>
  identity.loginDemo(user, undefined, {
    tenantId,
    environmentId: tenantId,
    generation: 1,
  });

describe('真实服务端身份和授权边界', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId,
      environmentId: tenantId,
      generation: 1,
    });
    identity.registerResourceResolver('expense_claim', async (_ctx, ref) =>
      ref.id === 'test-tech-claim'
        ? {
            tenant_id: tenantId,
            owner_id: 'u-chen',
            department_id: 'dept-tech',
            version: 1,
          }
        : ref.id === 'test-sales-claim'
          ? {
              tenant_id: tenantId,
              owner_id: 'u-wang',
              department_id: 'dept-sales',
              version: 1,
            }
          : null,
    );
    identity.registerResourceResolver('memory', async () => ({
      tenant_id: tenantId,
      owner_id: 'u-li',
      department_id: 'dept-sales',
      version: 1,
    }));
  });
  afterAll(async () => {
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenantId],
    );
    await database.close();
  });
  it('manager_cannot_read_other_department', async () => {
    const actor = await identity.getActor(
      (await login('u-zhang')).session_token,
    );
    await expect(
      identity.assertResourceAccess(actor, 'read', {
        type: 'expense_claim',
        id: 'test-tech-claim',
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      identity.assertResourceAccess(actor, 'read', {
        type: 'expense_claim',
        id: 'test-sales-claim',
        version: 1,
      }),
    ).resolves.toBeUndefined();
    expect(
      (await identity.getResourceScope(actor, 'expense.read')).department_ids,
    ).toEqual(['dept-sales']);
  });
  it('admin_cannot_read_employee_memory', async () => {
    const actor = await identity.getActor(
      (await login('u-zhao')).session_token,
    );
    await expect(
      identity.assertResourceAccess(actor, 'read', {
        type: 'memory',
        id: 'm-li',
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(actor.permissions).toContain('operations.read');
    expect(actor.permissions).not.toContain('expense.read.own');
  });
  it('production_rejects_demo_auth', async () => {
    expect(() =>
      createIdentityService(database, { ...options, appMode: 'production' }),
    ).toThrow();
    expect(() =>
      createIdentityService(database, {
        ...options,
        appMode: 'production',
        demoAccessEnabled: false,
      }),
    ).toThrow();
    const testIdentity = createIdentityService(database, {
      ...options,
      appMode: 'test',
    });
    await expect(testIdentity.loginDemo('u-li')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('切换与注销撤销旧签名会话，伪造签名被拒绝', async () => {
    const first = await login('u-li');
    expect((await identity.getActor(first.session_token)).user_id).toBe('u-li');
    const switched = await identity.loginDemo('u-wang', first.session_token, {
      tenantId,
      environmentId: tenantId,
      generation: 1,
    });
    await expect(identity.getActor(first.session_token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      identity.getActor(`${switched.session_token.slice(0, -1)}!`),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await identity.logout(switched.session_token);
    await identity.logout(switched.session_token);
    await expect(
      identity.getActor(switched.session_token),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('财务所属部门与授权部门分开，七身份四部门三组准确', async () => {
    const actor = await identity.getActor((await login('u-liu')).session_token);
    const me = await identity.getMe(actor);
    expect(me.department_id).toBe('dept-finance');
    expect(actor.department_ids).toEqual(['dept-sales', 'dept-tech']);
    expect(
      (await identity.searchPeople(actor, { limit: 100 })).items,
    ).toHaveLength(7);
    expect(
      (await identity.listDepartments(actor, { limit: 100 })).items,
    ).toHaveLength(4);
    expect(
      (await identity.listGroups(actor, { limit: 100 })).items,
    ).toHaveLength(3);
    expect(await identity.isGroupMember(actor, 'g-finance-demo', 'u-liu')).toBe(
      true,
    );
    expect(
      await identity.isGroupMember(actor, 'g-finance-demo', 'u-zhang'),
    ).toBe(false);
    await expect(
      identity.assertGroupExists(actor, 'missing'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('城市歧义保留多候选，成本中心不越组织', async () => {
    const actor = await identity.getActor((await login('u-li')).session_token);
    const ambiguous = await identity.resolvePlace(actor, '朝阳');
    expect(ambiguous.requires_selection).toBe(true);
    expect(ambiguous.candidates).toHaveLength(2);
    expect(
      (await identity.resolvePlace(actor, '余杭')).candidates[0]?.parent_city
        ?.id,
    ).toBe('city-hangzhou');
    expect(
      (await identity.listCostCenters(actor, '2026-11-05')).map(
        (item) => item.id,
      ),
    ).toEqual(['cc-sales']);
    await expect(
      identity.validateCostCenter(actor, 'cc-tech', '2026-11-05'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('revoked_scope_blocks_next_tool', async () => {
    const session = await login('u-zhang');
    const oldActor = await identity.getActor(session.session_token);
    await identity.assertResourceAccess(oldActor, 'read', {
      type: 'expense_claim',
      id: 'test-sales-claim',
      version: 1,
    });
    const currentGrants = await identity.listMyGrants(oldActor);
    await identity.applyDemoGrantChange({
      tenantId,
      targetUserId: 'u-zhang',
      expectedVersion: oldActor.authz_version,
      grants: currentGrants.filter(
        (g) =>
          g.scope_type !== 'department' && g.scope_type !== 'assigned_task',
      ),
      reason: '测试场景撤销销售范围',
      traceId: 'trace-revocation',
    });
    await expect(
      identity.assertResourceAccess(oldActor, 'read', {
        type: 'expense_claim',
        id: 'test-sales-claim',
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    const current = await identity.getActor(session.session_token);
    expect(current.authz_version).toBe(oldActor.authz_version + 1);
    await expect(
      identity.assertResourceAccess(current, 'read', {
        type: 'expense_claim',
        id: 'test-sales-claim',
        version: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('会话过期与闲置使用真实时钟，CSRF必须绑定当前会话', async () => {
    const first = await login('u-li');
    const second = await login('u-wang');
    await expect(
      identity.validateCsrf(first.session_token, second.csrf_token),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await identity.validateCsrf(first.session_token, first.csrf_token);
    const actor = await identity.getActor(first.session_token);
    await database.pool.query(
      "UPDATE identity_sessions SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",
      [tenantId, actor.session_id],
    );
    await expect(identity.getActor(first.session_token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    const idle = await login('u-li');
    const idleActor = await identity.getActor(idle.session_token);
    await database.pool.query(
      "UPDATE identity_sessions SET last_seen_at=now()-interval '31 minutes' WHERE tenant_id=$1 AND id=$2",
      [tenantId, idleActor.session_id],
    );
    await expect(identity.getActor(idle.session_token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('身份切换丢回包后幂等重试只签发一次有效会话', async () => {
    const first = await login('u-li');
    const env = { tenantId, environmentId: tenantId, generation: 1 };
    const command = {
      key: 'identity-switch-retry',
      operation: 'switch' as const,
    };
    const switched = await identity.loginDemo(
      'u-wang',
      first.session_token,
      env,
      command,
    );
    const retried = await identity.loginDemo(
      'u-wang',
      first.session_token,
      env,
      command,
    );
    expect(retried.session_token).toBe(switched.session_token);
    await expect(
      identity.loginDemo('u-chen', first.session_token, env, command),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const stored = await database.pool.query(
      'SELECT token_hash,csrf_hash FROM identity_sessions WHERE tenant_id=$1 AND id=$2',
      [tenantId, switched.me.actor.session_id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(switched.session_token);
    expect(JSON.stringify(stored.rows)).not.toContain(switched.csrf_token);
  });
  it('订阅只读委托退出仍有效，撤销后旧后台身份拒绝', async () => {
    const signedIn = await login('u-sun');
    const actor = await identity.getActor(signedIn.session_token);
    const delegation = await identity.createSubscriptionDelegation(actor, {
      subscriptionId: 'sub-test',
      allowedCapabilities: ['expense.read.department', 'analytics.query'],
    });
    const background = await identity.getActorFromSubscription(
      tenantId,
      delegation.id,
    );
    expect(background).toMatchObject({
      invocation_origin: 'subscription',
      session_id: null,
      delegation_id: delegation.id,
    });
    await identity.logout(signedIn.session_token);
    await expect(
      identity.requireCurrentActor(background),
    ).resolves.toMatchObject({ user_id: 'u-sun' });
    await expect(
      identity.createSubscriptionDelegation(background, {
        subscriptionId: 'invalid',
        allowedCapabilities: ['approval.decide'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const newSession = await login('u-sun');
    const newActor = await identity.getActor(newSession.session_token);
    await identity.revokeSubscriptionDelegation(newActor, delegation.id);
    await expect(
      identity.requireCurrentActor(background),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('移出授权组递增权限版本，旧访问上下文立即失效', async () => {
    const actor = await identity.getActor((await login('u-liu')).session_token);
    await identity.setDemoGroupMembership({
      tenantId,
      groupId: 'g-finance-demo',
      userId: 'u-liu',
      member: false,
      reason: '撤销财务Skill组',
      traceId: 'trace-group',
    });
    await expect(identity.requireCurrentActor(actor)).rejects.toMatchObject({
      code: 'REVALIDATION_REQUIRED',
    });
    const fresh = await identity.getActor((await login('u-liu')).session_token);
    expect(await identity.isGroupMember(fresh, 'g-finance-demo', 'u-liu')).toBe(
      false,
    );
  });
  it('平台管理员不能自行增权，拒绝后权限与版本不变', async () => {
    const actor = await identity.getActor(
      (await login('u-zhao')).session_token,
    );
    await expect(
      identity.replaceGrants(actor, {
        tenantId,
        targetUserId: 'u-zhao',
        expectedVersion: actor.authz_version,
        grants: [
          {
            capability: 'expense.read.department',
            scope_type: 'department',
            scope_ids: ['dept-sales'],
            effect: 'allow',
          },
        ],
        reason: '自助增权',
        traceId: 'trace-forbidden',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await identity.requireCurrentActor(actor)).authz_version).toBe(
      actor.authz_version,
    );
  });
  it('签名密钥按key_id轮换，保留旧密钥时旧会话可验证', async () => {
    const first = await login('u-li');
    const rotated = createIdentityService(database, {
      ...options,
      sessionKeys: {
        primary: options.sessionSecret,
        next: 'next-test-session-secret-at-least-32-characters',
      },
      activeSigningKeyId: 'next',
    });
    expect((await rotated.getActor(first.session_token)).user_id).toBe('u-li');
    const second = await rotated.loginDemo('u-wang', undefined, {
      tenantId,
      environmentId: tenantId,
      generation: 1,
    });
    expect(second.session_token.split('.')[1]).toBe('next');
    await rotated.validateCsrf(
      first.session_token,
      (await rotated.getMe(await rotated.getActor(first.session_token)))
        .csrf_token!,
    );
    await expect(identity.getActor(second.session_token)).rejects.toMatchObject(
      { code: 'UNAUTHENTICATED' },
    );
  });
  it('HTTP可信Cookie与Origin/CSRF边界，登录返回不含会话令牌', async () => {
    const app = createApp({
      database: async () => {},
      storage: async () => {},
      dataMode: 'demo',
    });
    registerIdentityRoutes(app, {
      identity,
      appMode: 'demo',
      demoAccessGate: async () => ({
        tenantId,
        environmentId: tenantId,
        generation: 1,
      }),
    });
    try {
      const unauthenticated = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { 'x-user-id': 'u-li', 'x-roles': 'finance' },
      });
      expect(unauthenticated.statusCode).toBe(401);
      const payload = {
        demo_environment_id: tenantId,
        generation: 1,
        selected_user_id: 'u-li',
      };
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/demo/login',
        headers: {
          origin: 'http://localhost',
          'idempotency-key': 'http-login-1',
        },
        payload,
      });
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().data.actor.user_id).toBe('u-li');
      expect(signedIn.json().data.session_token).toBeUndefined();
      const setCookie = signedIn.headers['set-cookie'] as string;
      expect(setCookie).toContain('__Host-caixiaozhi_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      const cookie = setCookie.split(';')[0]!;
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/me',
            headers: { cookie },
          })
        ).json().data.actor.user_id,
      ).toBe('u-li');
      const switchRequest = {
        method: 'POST' as const,
        url: '/api/v1/auth/demo/switch',
        payload: { generation: 1, selected_user_id: 'u-wang' },
      };
      expect(
        (
          await app.inject({
            ...switchRequest,
            headers: {
              cookie,
              origin: 'http://localhost',
              'idempotency-key': 'http-switch-1',
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            ...switchRequest,
            headers: {
              cookie,
              origin: 'https://attacker.example',
              'idempotency-key': 'http-switch-1',
              'x-csrf-token': signedIn.json().data.csrf_token,
            },
          })
        ).statusCode,
      ).toBe(403);
      const switched = await app.inject({
        ...switchRequest,
        headers: {
          cookie,
          origin: 'http://localhost',
          'idempotency-key': 'http-switch-1',
          'x-csrf-token': signedIn.json().data.csrf_token,
        },
      });
      expect(switched.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/me',
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it('APP_MODE=test及缺少DemoAccessGate均不注册演示登录路由', async () => {
    for (const mode of ['test', 'demo'] as const) {
      const app = createApp({
        database: async () => {},
        storage: async () => {},
        dataMode: 'demo',
      });
      registerIdentityRoutes(app, { identity, appMode: mode });
      try {
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/auth/demo/login',
              payload: {},
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await app.close();
      }
    }
  });
});
