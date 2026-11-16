import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createAnalyticsService } from '../../packages/insights/src/analytics.js';
import { createSkillService } from '../../packages/insights/src/skills.js';
import { createControlledDshGenerator } from '../../packages/application/src/dsh-generation.js';
import { installBuiltinCapabilities } from '../../packages/integrations/src/registry.js';
import { BUILTIN_CAPABILITIES } from '../../packages/integrations/src/catalog.js';
import { enqueueJob } from '../../packages/insights/src/shared.js';

const database = createDatabase(loadConfig().databaseUrl),
  tenant = `job-generation-${randomUUID()}`,
  plainTenant = `plain-generation-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'generation-integration-real-session-secret',
  appMode: 'demo',
  demoAccessEnabled: true,
});
let actor: ActorContext;
const analytics = createAnalyticsService(database.db, {
  freshActor: (a) => identity.requireCurrentActor(a),
  getResourceScope: async () => ({
    tenant_id: tenant,
    owner_ids: [],
    department_ids: ['dept-sales'],
  }),
});
const skills = createSkillService(database.db, {
  freshActor: (a) => identity.requireCurrentActor(a),
  isGroupMember: async () => false,
});
const plan = {
  metric: 'expense.completed_amount',
  period: {
    from: '2026-11-01',
    to_exclusive: '2026-11-06',
    timezone: 'Asia/Shanghai',
    date_basis: 'completed_at',
  },
  dimensions: [],
  filters: { scope: 'department', department_ids: ['dept-sales'] },
};
describe('领域任务记录当前环境代际', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 7,
    });
    const session = await identity.loginDemo('u-zhang', undefined, {
      tenantId: tenant,
      environmentId: tenant,
      generation: 7,
    });
    actor = await identity.getActor(session.session_token);
    await installBuiltinCapabilities(database.db, tenant, BUILTIN_CAPABILITIES);
  });
  afterAll(async () => {
    for (const current of [tenant, plainTenant]) {
      await database.db.execute(
        sql`DELETE FROM model_generation_events WHERE tenant_id=${current}`,
      );
      await database.db.execute(
        sql`DELETE FROM model_generation_tasks WHERE tenant_id=${current}`,
      );
      await database.db.execute(
        sql`DELETE FROM model_slots WHERE tenant_id=${current}`,
      );
      await database.db.execute(
        sql`DELETE FROM durable_jobs WHERE tenant_id=${current}`,
      );
      await database.db.execute(
        sql`DELETE FROM identity_environments WHERE tenant_id=${current}`,
      );
    }
    await database.close();
  });
  it('分析与Skill验证新任务写入真实generation=7', async () => {
    const query = await analytics.query(actor, plan, randomUUID());
    const skill = await skills.createSkill(
      actor,
      {
        slug: `generation-${randomUUID()}`,
        title: '代际测试',
        summary: '验证新任务代际',
      },
      randomUUID(),
    );
    await skills.seedBuiltinSkills(tenant, {
      owner_id: actor.user_id,
      private_owner_id: 'u-finance',
      reviewer_id: 'u-li',
      finance_group_id: 'finance',
    });
    const source = await skills.getSkillSource(
      actor,
      'skill-knowledge',
      'skill-knowledge-v1',
    );
    const version = await skills.saveVersion(
      actor,
      skill.id,
      {
        expected_version: skill.version,
        manifest: source.manifest,
        markdown: source.markdown,
      },
      randomUUID(),
    );
    const validation = await skills.validateVersion(
      actor,
      skill.id,
      version.id,
      { expected_version: version.version },
      randomUUID(),
    );
    const jobs = (
      await database.db.execute(
        sql`SELECT kind,generation FROM durable_jobs WHERE id IN(${query.job_id},${validation.job_id}) ORDER BY kind`,
      )
    ).rows;
    expect(jobs).toEqual([
      { kind: 'analytics.query', generation: 7 },
      { kind: 'skills.validate', generation: 7 },
    ]);
  });
  it('受控生成同样写入当前代际，缺模型仍保留真实blocked', async () => {
    const generator = createControlledDshGenerator({
      database,
      freshActor: (a) => identity.requireCurrentActor(a),
      assertResourceAccess: async () => {},
      modelConfigured: false,
    });
    await expect(
      generator.controlledDshJson({
        actor,
        operation: 'knowledge.answer',
        prompt: '检查代际',
        schema: { type: 'object', properties: {}, additionalProperties: false },
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      details: { status: 'blocked' },
    });
    const jobs = (
      await database.db.execute(
        sql`SELECT j.generation,t.state FROM durable_jobs j JOIN model_generation_tasks t ON t.job_id=j.id WHERE j.tenant_id=${tenant}`,
      )
    ).rows;
    expect(jobs).toEqual([{ generation: 7, state: 'blocked' }]);
  });
  it('无演示身份环境默认0，显式代际保留调用者值', async () => {
    const plain = { ...actor, tenant_id: plainTenant };
    const [zero, explicit] = await database.db.transaction(async (tx) => [
      await enqueueJob(tx, plain, 'analytics.query', randomUUID()),
      await enqueueJob(tx, plain, 'analytics.query', randomUUID(), 3),
    ]);
    expect(
      (
        await database.db.execute(
          sql`SELECT generation FROM durable_jobs WHERE id=${zero}`,
        )
      ).rows[0],
    ).toEqual({ generation: 0 });
    expect(
      (
        await database.db.execute(
          sql`SELECT generation FROM durable_jobs WHERE id=${explicit}`,
        )
      ).rows[0],
    ).toEqual({ generation: 3 });
  });
});
