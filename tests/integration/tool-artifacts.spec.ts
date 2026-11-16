import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import type { ExecutionContext } from '@caixiaozhi/contracts/integrations';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { loadConfig } from '@caixiaozhi/platform/config';
import { AppError } from '@caixiaozhi/platform/errors';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createRunService } from '../../packages/agent-runtime/src/runs.js';
import { createToolArtifacts } from '../../packages/application/src/tool-artifacts.js';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3),
  tenant = `tool-artifacts-${randomUUID()}`,
  keys = new Set<string>();
const identity = createIdentityService(database, {
  sessionSecret: 'tool-artifact-real-integration-session-secret',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const runs = createRunService(database, {
  freshActor: (a) => identity.requireCurrentActor(a),
  userSlots: 20,
  tenantSlots: 50,
});
const tracked = {
  ...storage,
  putObject: async (input: Parameters<typeof storage.putObject>[0]) => {
    keys.add(input.key);
    return storage.putObject(input);
  },
};
let actor: ActorContext, other: ActorContext, admin: ActorContext;
const output = { text: '真实工具私有结果。'.repeat(18000) };
const artifacts = createToolArtifacts({
  database,
  storage: tracked,
  runs,
  freshActor: (a) => identity.requireCurrentActor(a),
});
async function context(): Promise<ExecutionContext> {
  const run = await runs.createRun(
      actor,
      { thread_id: randomUUID(), input_message_id: randomUUID() },
      randomUUID(),
    ),
    lease = await runs.claimRun('tool-artifact-worker', { tenant_id: tenant });
  if (!lease || lease.run.id !== run.id)
    throw new Error('未领取本测试的真实运行租约');
  return {
    actor,
    run_id: run.id,
    lease_epoch: lease.lease_epoch,
    selected_skill_version_id: null,
    allowed_capability_versions: [],
    deadline_at: new Date(Date.now() + 60000).toISOString(),
  };
}
describe('大工具输出的真实S3产物与运行授权', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    const people = await Promise.all(
      ['u-zhang', 'u-li', 'u-zhao'].map(async (id) =>
        identity.getActor(
          (
            await identity.loginDemo(id, undefined, {
              tenantId: tenant,
              environmentId: tenant,
              generation: 1,
            })
          ).session_token,
        ),
      ),
    );
    [actor, other, admin] = people as [
      ActorContext,
      ActorContext,
      ActorContext,
    ];
  });
  afterAll(async () => {
    for (const key of keys) await storage.deleteObject(key).catch(() => {});
    await database.pool.query('DELETE FROM tool_artifacts WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query('DELETE FROM agent_runs WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query(
      'DELETE FROM runtime_fairness WHERE tenant_id=$1',
      [tenant],
    );
    await database.pool.query('DELETE FROM outbox_events WHERE tenant_id=$1', [
      tenant,
    ]);
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenant],
    );
    storage.close();
    await database.close();
  });
  it('大JSON只存私有S3与hash元数据，本人下载且他人与管理员均不能读取', async () => {
    const ctx = await context(),
      saved = await artifacts.store(ctx, output),
      id = saved.artifact_ref.slice('artifact:'.length);
    const metadata = (
      await database.pool.query(
        'SELECT owner_id,run_id,authz_version,size_bytes,sha256,object_key FROM tool_artifacts WHERE tenant_id=$1 AND id=$2',
        [tenant, id],
      )
    ).rows[0];
    expect(metadata).toMatchObject({
      owner_id: actor.user_id,
      run_id: ctx.run_id,
      authz_version: String(actor.authz_version),
    });
    expect(metadata.size_bytes).toBeGreaterThan(128 * 1024);
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    const downloaded = await artifacts.download(actor, ctx.run_id, id);
    expect(JSON.parse(Buffer.from(downloaded.bytes).toString('utf8'))).toEqual(
      output,
    );
    await expect(
      artifacts.download(other, ctx.run_id, id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      artifacts.download(admin, ctx.run_id, id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('有效租约属于他人时也不能为错误actor保存产物', async () => {
    const ctx = await context();
    await expect(
      artifacts.store({ ...ctx, actor: other }, output),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS count FROM tool_artifacts WHERE tenant_id=$1 AND run_id=$2',
          [tenant, ctx.run_id],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });
  it('S3写入后租约epoch变化时原子拒绝元数据并删除孤儿对象', async () => {
    const ctx = await context();
    let checks = 0,
      written = '';
    const racing = createToolArtifacts({
      database,
      runs,
      storage: {
        ...tracked,
        putObject: async (input) => {
          written = input.key;
          return tracked.putObject(input);
        },
      },
      freshActor: async (a) => {
        const current = await identity.requireCurrentActor(a);
        if (++checks === 2)
          await database.pool.query(
            'UPDATE run_leases SET lease_epoch=lease_epoch+1 WHERE run_id=$1',
            [ctx.run_id],
          );
        return current;
      },
    });
    await expect(racing.store(ctx, output)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS count FROM tool_artifacts WHERE tenant_id=$1 AND run_id=$2',
          [tenant, ctx.run_id],
        )
      ).rows[0],
    ).toEqual({ count: 0 });
    expect(written).not.toBe('');
    expect(
      await storage.getObject(written).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  it('S3完成写入但客户端收到失败时同样清除孤儿对象', async () => {
    const ctx = await context();
    let written = '';
    const failed = createToolArtifacts({
      database,
      runs,
      freshActor: (a) => identity.requireCurrentActor(a),
      storage: {
        ...tracked,
        putObject: async (input) => {
          written = input.key;
          await tracked.putObject(input);
          throw new AppError('DEPENDENCY_UNAVAILABLE', '上传回执中断');
        },
      },
    });
    await expect(failed.store(ctx, output)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(written).not.toBe('');
    expect(
      await storage.getObject(written).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  it('真实S3读取期间撤权后不返回正文', async () => {
    const ctx = await context(),
      saved = await artifacts.store(ctx, output),
      id = saved.artifact_ref.slice('artifact:'.length);
    const revoked = createToolArtifacts({
      database,
      runs,
      freshActor: (a) => identity.requireCurrentActor(a),
      storage: {
        ...tracked,
        getObject: async (key) => {
          const result = await storage.getObject(key);
          await database.pool.query(
            'UPDATE identities SET authz_version=authz_version+1 WHERE tenant_id=$1 AND id=$2',
            [tenant, actor.user_id],
          );
          return result;
        },
      },
    });
    expect(
      await revoked.download(actor, ctx.run_id, id).then(
        () => 'returned',
        (error) => error.code,
      ),
    ).toBe('REVALIDATION_REQUIRED');
  });
});
