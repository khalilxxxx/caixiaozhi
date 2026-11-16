import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import type { ActorContext } from '@caixiaozhi/contracts';
import type {
  ExecutionContext,
  CapabilityDefinition,
} from '@caixiaozhi/contracts/integrations';
import { createToolGateway } from '../../apps/api/src/modules/integrations/tool-gateway.js';
import { installBuiltinCapabilities } from '../../apps/api/src/modules/integrations/registry.js';
import { createWorkflowCallbacks } from '../../apps/api/src/modules/integrations/workflow.js';
import { loadCompletedToolResults } from '../../packages/application/src/runtime-context.js';
const database = createDatabase(loadConfig().databaseUrl),
  tenant = `gateway-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'employee',
  roles: ['employee'],
  department_ids: ['sales'],
  permissions: ['travel.read.own'],
  authz_version: 1,
  session_id: 'session',
  invocation_origin: 'interactive',
  delegation_id: null,
};
const definition: CapabilityDefinition = {
  id: 'test-document-v1',
  name: 'finance.document.get',
  version: '1.0.0',
  title: '单据',
  description: '测试读取',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, prompt: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, version: { type: 'integer' } },
    required: ['id', 'version'],
    additionalProperties: false,
  },
  effect: 'read',
  required_permissions: ['travel.read.own'],
  connector_id: 'demo-business',
  timeout_ms: 1000,
  supports_idempotency: true,
  supports_receipt_lookup: true,
};
let lease = 1,
  currentActor = actor;
const gateway = createToolGateway(database.db, {
  freshActor: async () => currentActor,
  assertLease: async (ctx) => {
    if (ctx.lease_epoch !== lease)
      throw Object.assign(new Error('失去租约'), { code: 'VERSION_CONFLICT' });
  },
  consumeBudget: async () => {},
  resolveSkillCapabilities: async () => [],
  assertResourceAccess: async () => {},
});
gateway.registerTool(definition, {
  authorize: async (ctx, args) => {
    if ((args as { id: string }).id === 'secret')
      throw Object.assign(new Error('无权'), { code: 'NOT_FOUND' });
  },
  execute: async (args) => ({
    status: 'ok',
    data: { id: (args as { id: string }).id, version: 1 },
    evidence_refs: [],
    action_id: null,
    error_code: null,
  }),
});
const context = (): ExecutionContext => ({
  actor,
  run_id: `run-${randomUUID()}`,
  lease_epoch: 1,
  selected_skill_version_id: null,
  allowed_capability_versions: [definition.id],
  deadline_at: new Date(Date.now() + 60000).toISOString(),
});
const request = (ctx: ExecutionContext, args: unknown) => ({
  name: definition.name,
  version: definition.version,
  arguments: args,
  run_id: ctx.run_id,
  call_id: randomUUID(),
});
describe('持久化能力网关授权和隔离', () => {
  beforeAll(async () => {
    await installBuiltinCapabilities(database.db, tenant, [definition]);
  });
  afterAll(async () => {
    await database.db.execute(
      sql`DELETE FROM integration_workflow_callbacks WHERE connector_id=${tenant}`,
    );
    for (const table of [
      'integration_workflow_runs',
      'outbox_events',
      'integration_invocations',
      'integration_capability_tests',
      'integration_tool_bindings',
      'integration_capability_versions',
      'integration_capabilities',
      'integration_connectors',
    ])
      await database.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    await database.close();
  });
  it('模型不能覆盖actor，合法资源使用同一handler', async () => {
    const ctx = context();
    expect(
      await gateway.dispatchTool(
        request(ctx, { id: 'mine', actor: { user_id: 'finance' } }),
        ctx,
      ),
    ).toMatchObject({
      status: 'requires_input',
      error_code: 'VALIDATION_ERROR',
    });
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({ status: 'ok', data: { id: 'mine', version: 1 } });
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'secret' }), ctx),
    ).toMatchObject({ status: 'rejected', error_code: 'NOT_FOUND' });
  });
  it('Skill声明和profile交集不能扩大权限', async () => {
    const ctx = { ...context(), selected_skill_version_id: 'skill-one' };
    expect(await gateway.listAllowedTools(ctx)).toEqual([]);
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({ status: 'rejected' });
  });
  it('撤权和失租约阻止下一工具', async () => {
    currentActor = { ...actor, authz_version: 2, permissions: [] };
    let ctx = context();
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({ status: 'rejected' });
    currentActor = actor;
    lease = 2;
    ctx = context();
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({ status: 'rejected' });
    lease = 1;
  });
  it('持久调用幂等与敏感参数脱敏', async () => {
    const ctx = context(),
      r = request(ctx, { id: 'mine', prompt: '票据含个人隐私' });
    const result = await gateway.dispatchTool(r, ctx);
    expect(await gateway.dispatchTool(r, ctx)).toEqual(result);
    expect(
      await gateway.dispatchTool({ ...r, arguments: { id: 'changed' } }, ctx),
    ).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
    const rows = await database.db.execute(
      sql`SELECT redacted_args FROM integration_invocations WHERE tenant_id=${tenant} AND call_id=${r.call_id}`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain('票据含个人隐私');
  });
  it('权限epoch改变后相同call_id不能复用原正文', async () => {
    const old = context(),
      r = request(old, { id: 'old-authorized-document' });
    expect(await gateway.dispatchTool(r, old)).toMatchObject({
      status: 'ok',
      data: { id: 'old-authorized-document' },
    });
    currentActor = { ...actor, authz_version: 2 };
    try {
      const result = await gateway.dispatchTool(r, {
        ...old,
        actor: currentActor,
      });
      expect(result).toMatchObject({
        status: 'rejected',
        error_code: 'REVALIDATION_REQUIRED',
        data: null,
      });
      expect(JSON.stringify(result)).not.toContain('old-authorized-document');
    } finally {
      currentActor = actor;
    }
  });
  it('续接正文只读取同权限epoch和当前允许能力，调用快照不可篡改', async () => {
    const ctx = context(),
      r = request(ctx, { id: 'resume-secret' });
    expect((await gateway.dispatchTool(r, ctx)).status).toBe('ok');
    const tools = await gateway.listAllowedTools(ctx);
    const resumed = await loadCompletedToolResults(
      database,
      actor,
      ctx.run_id,
      tools,
    );
    expect(resumed).toMatchObject([
      {
        call_id: r.call_id,
        name: definition.name,
        result: { status: 'ok', data: null, evidence_refs: [] },
      },
    ]);
    expect(JSON.stringify(resumed)).not.toContain('resume-secret');
    expect(
      await loadCompletedToolResults(
        database,
        { ...actor, authz_version: 2 },
        ctx.run_id,
        tools,
      ),
    ).toEqual([]);
    expect(
      await loadCompletedToolResults(database, actor, ctx.run_id, []),
    ).toEqual([]);
    expect(
      await loadCompletedToolResults(
        database,
        { ...actor, user_id: 'another-user' },
        ctx.run_id,
        tools,
      ),
    ).toEqual([]);
    await expect(
      database.pool.query(
        'UPDATE integration_invocations SET authz_version=2 WHERE tenant_id=$1 AND run_id=$2',
        [tenant, ctx.run_id],
      ),
    ).rejects.toThrow('immutable');
  });
  it('输出不符合schema和超过128KiB均不进入模型上下文', async () => {
    gateway.registerTool(definition, {
      authorize: async () => {},
      execute: async () => ({
        status: 'ok',
        data: { id: 1, version: 'wrong' },
        evidence_refs: [],
        action_id: null,
        error_code: null,
      }),
    });
    let ctx = context();
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({
      status: 'error',
      data: null,
      error_code: 'DEPENDENCY_UNAVAILABLE',
    });
    gateway.registerTool(definition, {
      authorize: async () => {},
      execute: async () => ({
        status: 'ok',
        data: { id: 'x'.repeat(128 * 1024), version: 1 },
        evidence_refs: [],
        action_id: null,
        error_code: null,
      }),
    });
    ctx = context();
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({
      status: 'error',
      data: null,
      error_code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
  it('workflow_timeout_preserves_unknown；验签回调重放仅一次结果和outbox', async () => {
    const externalId = randomUUID(),
      secret = 'callback-test-secret-more-than-thirty-two-bytes';
    await database.db.execute(
      sql`INSERT INTO integration_workflow_runs(id,tenant_id,actor_id,connector_id,external_run_id,operation,state,data_mode) VALUES(${randomUUID()},${tenant},${actor.user_id},${tenant},${externalId},'invoice.extract','running','demo')`,
    );
    const callbacks = createWorkflowCallbacks(database.db, {
      resolveSecret: async () => secret,
      resolveOutputSchema: async () => ({
        type: 'object',
        properties: { amount: { type: 'string' } },
        required: ['amount'],
        additionalProperties: false,
      }),
    });
    await callbacks.markUnknown(tenant, externalId);
    expect(
      (
        await database.db.execute(
          sql`SELECT state FROM integration_workflow_runs WHERE external_run_id=${externalId}`,
        )
      ).rows[0],
    ).toEqual({ state: 'unknown' });
    const raw = JSON.stringify({
        external_run_id: externalId,
        event_id: 'event-one',
        status: 'succeeded',
        output: { amount: '120000' },
      }),
      timestamp = String(Date.now());
    await expect(
      callbacks.accept(tenant, raw, { timestamp, signature: 'forged' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const headers = {
      timestamp,
      signature: createHmac('sha256', secret)
        .update(`${timestamp}.${raw}`)
        .digest('hex'),
    };
    expect(await callbacks.accept(tenant, raw, headers)).toEqual({
      accepted: true,
      changed: true,
    });
    expect(await callbacks.accept(tenant, raw, headers)).toEqual({
      accepted: true,
      changed: false,
    });
    expect(
      (
        await database.db.execute(
          sql`SELECT count(*)::int AS count FROM outbox_events WHERE tenant_id=${tenant}`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
  it('停用能力立即拒绝后续调用', async () => {
    await database.db.execute(
      sql`UPDATE integration_capabilities SET status='disabled' WHERE tenant_id=${tenant}`,
    );
    const ctx = context();
    expect(await gateway.listAllowedTools(ctx)).toEqual([]);
    expect(
      await gateway.dispatchTool(request(ctx, { id: 'mine' }), ctx),
    ).toMatchObject({ status: 'rejected' });
  });
});
