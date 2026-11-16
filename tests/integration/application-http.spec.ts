import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  createDatabase,
  checkDatabaseReady,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
import { createProductApp } from '../../apps/api/src/product.js';
const config = {
  ...loadConfig(),
  cookieSecure: false,
  appMode: 'demo' as const,
  demoAccessEnabled: true,
  logLevel: 'silent' as const,
};
const database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `http-${randomUUID()}`,
  envId = `env-${tenant}`;
const services = createConfiguredApplication({
  database,
  storage,
  config,
  demoTenantId: tenant,
  demoEnvironmentId: envId,
});
// 集成入口用固定隔离环境。默认的浏览器入口仍使用demo-default。
const app = createProductApp(config, services, {
  database: () => checkDatabaseReady(database),
  storage: () => storage.checkReady(),
});
let cookie = '',
  csrf = '';
const origin = config.appOrigin;
describe('应用总装真实HTTP与持久服务', () => {
  beforeAll(async () => {
    await services.demo.initialize();
    await app.ready();
  }, 30000);
  afterAll(async () => {
    await app.close();
    storage.close();
    await database.close();
  });
  it('匿名无法读取业务或私有文件，健康响应没有内部配置', async () => {
    expect(
      (await app.inject({ url: '/api/v1/expenses/claims' })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/files/anything/content' })).statusCode,
    ).toBe(401);
    const health = await app.inject({ url: '/api/v1/health/ready' });
    expect(health.statusCode).toBe(200);
    expect(health.body).not.toContain('postgresql:');
  });
  it('真实会话读取5张销售待审554000分，写请求CSRF不可省略', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/demo/login',
      headers: { origin, 'idempotency-key': randomUUID() },
      payload: {
        selected_user_id: 'u-zhang',
        demo_environment_id: envId,
        generation: 1,
      },
    });
    expect(login.statusCode, login.body).toBe(200);
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode, me.body).toBe(200);
    csrf = me.json().data.csrf_token;
    const claims = await app.inject({
      url: '/api/v1/expenses/claims?state=pending_manager&limit=100',
      headers: { cookie },
    });
    expect(claims.statusCode, claims.body).toBe(200);
    expect(claims.json().data.items).toHaveLength(5);
    expect(
      claims
        .json()
        .data.items.reduce(
          (n: bigint, c: { total_amount: { amount_minor: string } }) =>
            n + BigInt(c.total_amount.amount_minor),
          0n,
        ),
    ).toBe(554000n);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/threads',
          headers: { cookie, origin, 'idempotency-key': randomUUID() },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it('预审通过真实队列与单据投影产生精确分组，浏览器看到真实进度', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/preaudit/tasks',
      headers: {
        cookie,
        origin,
        'x-csrf-token': csrf,
        'idempotency-key': randomUUID(),
      },
      payload: {
        purpose: 'manager_review',
        documents: ['001', '002', '003', '004', '005'].map((suffix) => ({
          type: 'expense_claim',
          id: `clm-${suffix}`,
          version: 1,
        })),
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    for (
      let n = 0;
      n < 20 && (await services.finance.processNextJob('http-finance-worker'));
      n++
    ) {}
    let task = await app.inject({
      url: `/api/v1/preaudit/tasks/${started.json().data.task_id}`,
      headers: { cookie },
    });
    for (
      let n = 0;
      n < 100 && ['queued', 'running'].includes(task.json().data.task.status);
      n++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      task = await app.inject({
        url: `/api/v1/preaudit/tasks/${started.json().data.task_id}`,
        headers: { cookie },
      });
    }
    expect(task.statusCode, task.body).toBe(200);
    expect(
      Object.fromEntries(
        Object.entries(task.json().data.summary.groups).map(([key, value]) => [
          key,
          (value as { count: number }).count,
        ]),
      ),
    ).toEqual({ risk: 1, incomplete: 1, attention: 1, low: 2 });
  });
});
