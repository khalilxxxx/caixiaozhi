import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { seedBusiness } from '../../packages/fixtures/src/business.js';
import { createDemoService } from '../../packages/demo/src/service.js';
import { createDemoScenarioController } from '../../packages/demo/src/scenarios.js';
import type {
  DemoJourneyReport,
  DemoJourneyRunnerOptions,
  DemoJourneyId,
} from '../../packages/demo/src/journeys.js';
import { createApp } from '../../apps/api/src/app.js';
import { createIdentityHttpContext } from '../../apps/api/src/modules/identity/routes.js';
import { registerDemoRoutes } from '../../apps/api/src/modules/demo/routes.js';
import type { ActorContext } from '@caixiaozhi/contracts';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  environmentId = `scenario-${randomUUID()}`,
  tenants: string[] = [];
const identity = createIdentityService(database, {
  sessionSecret: 'scenario-controller-real-session-integration-secret',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const demo = createDemoService(database, {
  appMode: 'demo',
  environmentId,
  logicalTenantId: `tenant-${environmentId}`,
  identity,
  seedEnvironment: async (input) => {
    tenants.push(input.tenantId);
    await identity.seedDemoIdentity({
      tenantId: input.tenantId,
      environmentId,
      generation: input.generation,
    });
    return seedBusiness({ database, storage, tenantId: input.tenantId });
  },
});
type Hooks = Pick<
  DemoJourneyRunnerOptions,
  'onEvidence' | 'heartbeat' | 'signal'
>;
let execute: (
  scenario: DemoJourneyId,
  hooks: Hooks,
) => Promise<DemoJourneyReport> = async () => {
  throw new Error('本测试必须显式配置控制器执行端口。');
};
const controller = createDemoScenarioController(database, {
  appMode: 'demo',
  environmentId,
  freshActor: (a) => identity.requireCurrentActor(a),
  run: (scenario, hooks) => execute(scenario, hooks),
});
const app = createApp({
    database: async () => {},
    storage: async () => {},
    dataMode: 'demo',
  }),
  http = createIdentityHttpContext(identity, {
    appMode: 'demo',
    cookieSecure: false,
  });
registerDemoRoutes(app, {
  demo,
  scenarios: controller,
  appMode: 'demo',
  actor: async (request, write) => {
    if (write) await http.assertCsrf(request);
    return http.requireActor(request);
  },
});
let actor: ActorContext, cookie: string, csrf: string;
async function login() {
  const current = await demo.gate.currentTenant(environmentId),
    session = await identity.loginDemo('u-zhao', undefined, {
      tenantId: current.tenant_id,
      environmentId,
      generation: current.generation,
    });
  actor = await identity.getActor(session.session_token);
  cookie = `caixiaozhi_session=${session.session_token}`;
  csrf = session.csrf_token;
}
const guard = async () => {
  const env = await demo.current(actor);
  return {
    expected_generation: env.generation,
    expected_environment_version: env.version,
    intent: 'run_isolated_demo_journey',
  };
};
const result = (
  scenario: DemoJourneyId,
  baseline: DemoJourneyReport['baseline'] = null,
): DemoJourneyReport => ({
  id: randomUUID(),
  scenario_id: scenario,
  status: 'succeeded',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  baseline,
  evidence: [],
  error: null,
});
describe('场景控制器真实PG租约与正式HTTP控制边界', () => {
  beforeAll(async () => {
    await demo.initialize();
    await login();
    await app.ready();
  }, 30000);
  afterAll(async () => {
    controller.stop();
    await app.close();
    const files = (
      await database.pool.query(
        'SELECT object_key FROM uploaded_files WHERE tenant_id=ANY($1::text[])',
        [tenants],
      )
    ).rows;
    for (const file of files)
      await storage.deleteObject(file.object_key).catch(() => {});
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('caixiaozhi.demo_control','on',true)",
      );
      for (const table of [
        'demo_control_commands',
        'demo_control_audit',
        'demo_scenario_runs',
        'demo_summary_triggers',
        'demo_fault_injections',
        'demo_reset_jobs',
        'demo_generation_manifests',
      ])
        await client.query(`DELETE FROM ${table} WHERE env_id=$1`, [
          environmentId,
        ]);
      await client.query('DELETE FROM demo_environments WHERE id=$1', [
        environmentId,
      ]);
      let pending = (
        await client.query(
          "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'",
        )
      ).rows.map((r) => String(r.table_name));
      for (let round = 0; round < 20 && pending.length; round++) {
        const next: string[] = [];
        for (const table of pending) {
          await client.query('SAVEPOINT cleanup_table');
          try {
            await client.query(
              `DELETE FROM "${table}" WHERE tenant_id=ANY($1::text[])`,
              [tenants],
            );
            await client.query('RELEASE SAVEPOINT cleanup_table');
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT cleanup_table');
            next.push(table);
          }
        }
        pending = next;
      }
      if (pending.length)
        throw new Error(`测试清理未完成：${pending.join(',')}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      storage.close();
      await database.close();
    }
  });
  it('仅固定八条旅程可启动，实际HTTP强制CSRF、幂等与单运行', async () => {
    const body = await guard(),
      headers = {
        cookie,
        origin: 'http://localhost',
        'x-csrf-token': csrf,
        'idempotency-key': randomUUID(),
      };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/demo/scenarios/E2E-09/start',
          headers,
          payload: body,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/demo/scenarios/E2E-01/start',
          headers,
          payload: { ...body, script: 'run' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/demo/scenarios/E2E-01/start',
          headers: {
            cookie,
            origin: 'http://localhost',
            'idempotency-key': randomUUID(),
          },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/scenarios/E2E-01/start',
      headers,
      payload: body,
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/scenarios/E2E-01/start',
      headers,
      payload: body,
    });
    expect(repeated.json().data.id).toBe(accepted.json().data.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/demo/scenarios/E2E-02/start',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    execute = async (scenario) => result(scenario);
    expect(await controller.processNext('scenario-worker')).toBe(true);
  });
  it('平台管理员读取旧宽证据时也只得到step/trace/ref/time白名单', async () => {
    const env = await demo.current(actor),
      legacy = await demo.startScenario(
        actor,
        'baseline',
        {
          expected_generation: env.generation,
          expected_environment_version: env.version,
        },
        randomUUID(),
      );
    const evidence = {
      step_id: 'legacy-step',
      passed: true,
      trace_id: 'trace-private-test',
      resource_refs: [],
      occurred_at: new Date().toISOString(),
      request: { body: { private_text: '禁止泄漏请求正文' } },
      response: { data: { private_text: '禁止泄漏响应正文' } },
      assertion: { actual: '禁止泄漏断言正文' },
    };
    await demo.recordEvidence(legacy.id, evidence);
    const view = await controller.get(actor, legacy.id);
    expect(view.evidence).toEqual([
      {
        step_id: evidence.step_id,
        passed: true,
        trace_id: evidence.trace_id,
        resource_refs: [],
        occurred_at: evidence.occurred_at,
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('禁止泄漏');
  });
  it('控制面租约跨正式reset存活，新代际管理员可查看完成元数据', async () => {
    const env = await demo.current(actor),
      started = await controller.start(
        actor,
        'E2E-03',
        await guard(),
        randomUUID(),
      );
    execute = async (scenario, hooks) => {
      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/demo/reset',
        headers: {
          cookie,
          origin: 'http://localhost',
          'x-csrf-token': csrf,
          'idempotency-key': randomUUID(),
        },
        payload: {
          expected_generation: env.generation,
          expected_environment_version: env.version,
          seed_version: 'finance-agent-v1.0',
          scenario_id: 'baseline',
          intent: 'reset_demo_environment',
        },
      });
      expect(reset.statusCode, reset.body).toBe(202);
      expect(await demo.runNextReset('scenario-reset-worker')).toBe(true);
      await login();
      const current = await demo.current(actor);
      expect(current.generation).toBe(env.generation + 1);
      await hooks.heartbeat?.();
      const evidence = {
        step_id: '正式reset完成',
        passed: true,
        trace_id: reset.json().meta.trace_id,
        resource_refs: [],
        occurred_at: new Date().toISOString(),
        request: {
          method: 'POST',
          path: '/api/v1/demo/reset',
          body: '不应保存',
        },
        response: { status: 202, data: '不应保存' },
      };
      await hooks.onEvidence?.(evidence);
      return result(scenario, {
        scenario_id: scenario,
        environment_id: environmentId,
        reset_job_id: reset.json().data.id,
        previous_generation: env.generation,
        generation: current.generation,
        manifest_hash: String(current.manifest_hash),
        evidence: [],
      });
    };
    expect(await controller.processNext('scenario-cross-reset')).toBe(true);
    const view = await controller.get(actor, started.id);
    expect(view).toMatchObject({
      state: 'passed',
      generation: env.generation,
      baseline_generation: env.generation + 1,
    });
    expect(view.evidence).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain('不应保存');
    const lease = (
      await database.pool.query(
        'SELECT lease_epoch,lease_owner,lease_until FROM demo_scenario_runs WHERE id=$1',
        [started.id],
      )
    ).rows[0];
    expect(lease).toEqual({
      lease_epoch: '1',
      lease_owner: null,
      lease_until: null,
    });
  }, 30000);
  it('租约到期的旧Worker不能写终态，新Worker按新epoch恢复', async () => {
    const started = await controller.start(
      actor,
      'E2E-02',
      await guard(),
      randomUUID(),
    );
    execute = async () => {
      await database.pool.query(
        "UPDATE demo_scenario_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [started.id],
      );
      throw new Error('模拟租约到期后旧执行器返回错误');
    };
    await controller.processNext('expired-scenario-worker');
    expect((await controller.get(actor, started.id)).state).toBe('running');
    execute = async (scenario) => result(scenario);
    await controller.processNext('recovered-scenario-worker');
    expect((await controller.get(actor, started.id)).state).toBe('passed');
    expect(
      (
        await database.pool.query(
          'SELECT lease_epoch FROM demo_scenario_runs WHERE id=$1',
          [started.id],
        )
      ).rows[0],
    ).toEqual({ lease_epoch: '2' });
  });
});
