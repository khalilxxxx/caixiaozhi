import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  createDatabase,
  checkDatabaseReady,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import type { ActionName } from '@caixiaozhi/contracts/actions';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts';
import { createConfiguredApplication } from '../../packages/application/src/demo.js';
import { createProductApp } from '../../apps/api/src/product.js';
import { createReceiptReconciler } from '../../apps/worker/src/reconciler/index.js';
const config = {
    ...loadConfig(),
    appMode: 'demo' as const,
    demoAccessEnabled: true,
    cookieSecure: false,
    logLevel: 'silent' as const,
  },
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `receipt-app-${randomUUID()}`,
  envId = `env-${tenant}`;
const services = createConfiguredApplication({
    database,
    storage,
    config,
    demoTenantId: tenant,
    demoEnvironmentId: envId,
  }),
  app = createProductApp(config, services, {
    database: () => checkDatabaseReady(database),
    storage: () => storage.checkReady(),
  });
type Session = { actor: ActorContext; cookie: string; csrf: string };
async function login(id: string): Promise<Session> {
  const session = await services.identity.loginDemo(id, undefined, {
    tenantId: tenant,
    environmentId: envId,
    generation: 1,
  });
  return {
    actor: await services.identity.getActor(session.session_token),
    cookie: `caixiaozhi_session=${session.session_token}`,
    csrf: session.csrf_token,
  };
}
async function confirm(
  session: Session,
  operation: ActionName,
  ref: ResourceRef,
  args: unknown = {},
) {
  const headers = {
      cookie: session.cookie,
      origin: config.appOrigin,
      'x-csrf-token': session.csrf,
      'idempotency-key': randomUUID(),
    },
    prepared = await app.inject({
      method: 'POST',
      url: '/api/v1/confirmations',
      headers,
      payload: { action: operation, resource_refs: [ref], args },
    });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const review = await app.inject({
    url: `/api/v1/confirmations/${prepared.json().data.confirmation_id}`,
    headers: { cookie: session.cookie },
  });
  expect(review.statusCode, review.body).toBe(200);
  const value = review.json().data;
  return app.inject({
    method: 'POST',
    url: `/api/v1/confirmations/${value.confirmation_id}/confirm`,
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: {
      expected_version: value.version,
      summary_hash: value.summary_hash,
      confirmation_token: value.confirmation_token,
    },
  });
}
describe('总装真实审批推进后原主管自动核实旧回执', () => {
  beforeAll(async () => {
    await services.demo.initialize();
    await app.ready();
  }, 30000);
  afterAll(async () => {
    await app.close();
    const files = (
      await database.pool.query(
        'SELECT object_key FROM uploaded_files WHERE tenant_id=$1',
        [tenant],
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
        await client.query(`DELETE FROM ${table} WHERE env_id=$1`, [envId]);
      await client.query('DELETE FROM demo_environments WHERE id=$1', [envId]);
      let pending = (
        await client.query(
          "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema WHERE c.table_schema=current_schema() AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'",
        )
      ).rows.map((r) => String(r.table_name));
      for (let n = 0; n < 20 && pending.length; n++) {
        const next: string[] = [];
        for (const table of pending) {
          await client.query('SAVEPOINT cleanup');
          try {
            await client.query(`DELETE FROM "${table}" WHERE tenant_id=$1`, [
              tenant,
            ]);
            await client.query('RELEASE SAVEPOINT cleanup');
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT cleanup');
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
  it('正式HTTP审批已真实批准但回包丢失，只查原business_receipt恢复且审批记录仅一条', async () => {
    const [employee, manager, admin] = await Promise.all([
      login('u-li'),
      login('u-zhang'),
      login('u-zhao'),
    ]);
    const submitted = await confirm(employee, 'travel.submit', {
      type: 'travel',
      id: 'trv-001',
      version: 1,
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().data.state).toBe('succeeded');
    const pending = await services.documents.get(
        manager.actor,
        'travel',
        'trv-001',
      ),
      ref = {
        type: 'travel' as const,
        id: 'trv-001',
        version: pending.version,
      },
      task = await services.approvals.currentTask(
        database.db,
        manager.actor,
        ref,
      ),
      env = await services.demo.current(admin.actor);
    await services.demo.armFault(
      admin.actor,
      {
        expected_generation: env.generation,
        expected_environment_version: env.version,
        kind: 'action.response_lost_after_commit',
        scope_alias: 'trv-001',
        hits: 1,
        ttl_minutes: 5,
      },
      randomUUID(),
    );
    const approved = await confirm(manager, 'approval.approve', ref, {
      task_ref: { id: task.id, version: task.version },
      reason: '总装核实测试已查看最新行程',
    });
    expect(approved.statusCode, approved.body).toBe(202);
    const action = approved.json().data;
    expect(action.state).toBe('unknown');
    expect(
      (await services.documents.get(manager.actor, 'travel', 'trv-001')).state,
    ).toBe('approved');
    await expect(
      services.identity.assertResourceAccess(
        manager.actor,
        'approval.decide',
        ref,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const before = await app.inject({
      url: `/api/v1/actions/${action.id}`,
      headers: { cookie: manager.cookie },
    });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().data.state).toBe('unknown');
    expect(
      (
        await app.inject({
          url: `/api/v1/actions/${action.id}`,
          headers: { cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(404);
    await database.pool.query(
      "UPDATE action_attempts SET reconcile_after=clock_timestamp()-interval '1 second' WHERE item_id=$1",
      [action.items[0].id],
    );
    await createReceiptReconciler({
      database,
      actions: services.actions,
      runs: services.runs,
    }).tick('application-receipt-worker', {
      tenant_id: tenant,
      action_id: action.id,
    });
    const after = await app.inject({
      url: `/api/v1/actions/${action.id}`,
      headers: { cookie: manager.cookie },
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().data).toMatchObject({
      state: 'succeeded',
      summary: { succeeded: 1, unknown: 0 },
    });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int count FROM approval_decisions WHERE tenant_id=$1 AND action_id=$2',
          [tenant, action.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int count FROM business_receipts WHERE tenant_id=$1 AND action_id=$2',
          [tenant, action.id],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
});
