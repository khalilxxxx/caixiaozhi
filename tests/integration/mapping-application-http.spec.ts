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
import { canonicalHash } from '../../packages/finance/src/hash.js';

const config = {
    ...loadConfig(),
    appMode: 'demo' as const,
    demoAccessEnabled: true,
    cookieSecure: false,
    logLevel: 'silent' as const,
  },
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `mapping-app-${randomUUID()}`,
  environment = `env-${tenant}`;
const services = createConfiguredApplication({
    database,
    storage,
    config,
    demoTenantId: tenant,
    demoEnvironmentId: environment,
  }),
  app = createProductApp(config, services, {
    database: () => checkDatabaseReady(database),
    storage: () => storage.checkReady(),
  });
type Session = { cookie: string; csrf: string };
async function login(id: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/demo/login',
    headers: { origin: config.appOrigin, 'idempotency-key': randomUUID() },
    payload: {
      selected_user_id: id,
      demo_environment_id: environment,
      generation: 1,
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const cookie = String(response.headers['set-cookie']).split(';')[0]!,
    me = await app.inject({ url: '/api/v1/me', headers: { cookie } });
  expect(me.statusCode, me.body).toBe(200);
  return { cookie, csrf: me.json().data.csrf_token };
}
const headers = (session: Session) => ({
  cookie: session.cookie,
  origin: config.appOrigin,
  'x-csrf-token': session.csrf,
  'idempotency-key': randomUUID(),
});
async function preaudit(session: Session) {
  const started = await app.inject({
    method: 'POST',
    url: '/api/v1/preaudit/tasks',
    headers: headers(session),
    payload: {
      purpose: 'manager_review',
      documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
    },
  });
  expect(started.statusCode, started.body).toBe(202);
  for (
    let n = 0;
    n < 20 &&
    (await services.finance.processNextJob('mapping-application-http-worker', {
      tenant_id: tenant,
    }));
    n++
  ) {}
  const response = await app.inject({
    url: `/api/v1/preaudit/tasks/${started.json().data.task_id}`,
    headers: { cookie: session.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().data.items[0].result;
}
describe('真实ConfiguredApplication的映射HTTP发布与预审归一化接线', () => {
  beforeAll(async () => {
    await services.demo.initialize();
    await app.ready();
  }, 30000);
  afterAll(async () => {
    await app.close();
    const objects = (
      await database.pool.query(
        'SELECT object_key FROM uploaded_files WHERE tenant_id=$1',
        [tenant],
      )
    ).rows;
    for (const row of objects) await storage.deleteObject(row.object_key);
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
          environment,
        ]);
      await client.query('DELETE FROM demo_environments WHERE id=$1', [
        environment,
      ]);
      let pending = (
        await client.query(
          "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'",
        )
      ).rows.map((row) => String(row.table_name));
      for (let n = 0; n < 20 && pending.length; n++) {
        const next: string[] = [];
        for (const table of pending) {
          await client.query('SAVEPOINT cleanup');
          try {
            await client.query(
              `DELETE FROM "${table.replace(/"/g, '""')}" WHERE tenant_id=$1`,
              [tenant],
            );
            await client.query('RELEASE SAVEPOINT cleanup');
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT cleanup');
            next.push(table);
          }
        }
        pending = next;
      }
      if (pending.length)
        throw new Error(`映射总装测试清理未完成：${pending.join(',')}`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      storage.close();
      await database.close();
    }
  }, 30000);

  it('正式HTTP人工样例→浏览器确认→实际预审输入使用治理版本，并保留原fault wrapper', async () => {
    const finance = await login('u-liu'),
      manager = await login('u-zhang'),
      baseline = await preaudit(manager);
    expect(baseline.group).toBe('low');
    const snapshot = (
      await database.pool.query(
        'SELECT input_snapshot FROM preaudit_results WHERE tenant_id=$1 AND id=$2',
        [tenant, baseline.result_id],
      )
    ).rows[0].input_snapshot;
    expect(snapshot.input.total_amount).toEqual({
      amount_minor: '56000',
      currency: 'CNY',
    });
    const mapping_json = {
      provider: 'demo-expenses',
      source_schema_version: 'expense-v1',
      module: 'expense_claim',
      field_catalog_version: 1,
      fields: [
        {
          target_field: 'total_amount',
          source_pointer: '/total_amount',
          transform: 'identity',
        },
      ],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/rule-mappings',
      headers: headers(finance),
      payload: {
        name: '总装验证保留金额并显式省略票据核验字段',
        department_ids: ['dept-sales'],
        mapping_json,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const mapping = created.json().data,
      draft = mapping.versions.find(
        (version: any) => version.id === mapping.draft_version_id,
      );
    const checked = await app.inject({
      method: 'POST',
      url: `/api/v1/rule-mappings/${mapping.id}/tests`,
      headers: headers(finance),
      payload: {
        expected_version: mapping.version,
        cases: [
          {
            name: '人工预期56000分保持，其他未映射字段未知',
            source: {
              provider: 'demo-expenses',
              source_schema_version: 'expense-v1',
              snapshot,
              data: snapshot.input,
            },
            expected: [
              {
                target_field: 'total_amount',
                state: 'known',
                value: { amount_minor: '56000', currency: 'CNY' },
              },
            ],
          },
        ],
      },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().data.passed).toBe(true);
    const prepared = await app.inject({
      method: 'POST',
      url: '/api/v1/confirmations',
      headers: headers(finance),
      payload: {
        action: 'rule.mapping.publish',
        resource_refs: [],
        args: {
          mapping_id: mapping.id,
          expected_version: mapping.version,
          draft_id: draft.id,
          draft_hash: draft.content_hash,
          test_run_id: checked.json().data.test_run_id,
        },
      },
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const review = await app.inject({
      url: `/api/v1/confirmations/${prepared.json().data.confirmation_id}`,
      headers: { cookie: finance.cookie },
    });
    expect(review.statusCode, review.body).toBe(200);
    const value = review.json().data;
    expect(value.summary.runtime_binding).toBe('live_demo');
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/v1/confirmations/${value.confirmation_id}/confirm`,
      headers: headers(finance),
      payload: {
        expected_version: value.version,
        summary_hash: value.summary_hash,
        confirmation_token: value.confirmation_token,
      },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().data.state).toBe('succeeded');
    expect(confirmed.json().data.resource_refs).toEqual([]);
    const current = await preaudit(manager);
    expect(current.group).toBe('incomplete');
    const normalized = (
      await database.pool.query(
        'SELECT input_snapshot FROM preaudit_results WHERE tenant_id=$1 AND id=$2',
        [tenant, current.result_id],
      )
    ).rows[0].input_snapshot;
    expect(normalized.input.total_amount).toEqual(snapshot.input.total_amount);
    expect(normalized.input.expense_items).toEqual(
      snapshot.input.expense_items,
    );
    expect(normalized.input.field_states.total_amount.state).toBe('known');
    expect(
      normalized.input.field_states[
        `invoices.${normalized.input.invoices[0].id}.verified`
      ].state,
    ).toBe('unmapped');
    expect(normalized.provenance.mapping_versions).toEqual([
      { id: draft.id, version: 1 },
    ]);
    expect(normalized.provenance.input_hash).toBe(
      canonicalHash(normalized.input),
    );
    const stored = (
      await database.pool.query(
        'SELECT content_hash FROM field_mapping_versions WHERE tenant_id=$1 AND id=$2',
        [tenant, draft.id],
      )
    ).rows[0];
    expect(stored.content_hash).toBe(canonicalHash(mapping_json));
    const old = await app.inject({
      url: `/api/v1/preaudit/results/${baseline.result_id}`,
      headers: { cookie: manager.cookie },
    });
    expect(old.statusCode, old.body).toBe(200);
    expect(old.json().data.status).toBe('stale');
    const adminSession = await services.identity.loginDemo(
        'u-zhao',
        undefined,
        { tenantId: tenant, environmentId: environment, generation: 1 },
      ),
      admin = await services.identity.getActor(adminSession.session_token),
      env = await services.demo.current(admin);
    await services.demo.armFault(
      admin,
      {
        expected_generation: env.generation,
        expected_environment_version: env.version,
        kind: 'preaudit.check_unavailable',
        scope_alias: 'clm-005',
        hits: 1,
        ttl_minutes: 5,
      },
      randomUUID(),
    );
    const unavailable = await app.inject({
      method: 'POST',
      url: '/api/v1/preaudit/tasks',
      headers: headers(manager),
      payload: {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json().error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
