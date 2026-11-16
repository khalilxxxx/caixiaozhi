import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createSkillService } from '../../packages/insights/src/skills.js';
import { installBuiltinCapabilities } from '../../apps/api/src/modules/integrations/registry.js';
import { BUILTIN_CAPABILITIES } from '../../apps/api/src/modules/integrations/catalog.js';
import { createActionService } from '../../packages/action-service/src/index.js';
const db = createDatabase(loadConfig().databaseUrl),
  tenant = `skills-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'u-test',
  roles: ['manager'],
  department_ids: ['dept-sales'],
  permissions: ['skill.use', 'skill.manage'],
  authz_version: 1,
  session_id: 's',
  invocation_origin: 'interactive',
  delegation_id: null,
};
const admin: ActorContext = {
  ...actor,
  user_id: 'u-admin',
  roles: ['platform_admin'],
  permissions: ['skill.use', 'skill.manage', 'integration.manage'],
};
const service = createSkillService(db.db, {
  freshActor: async (a) => a,
  isGroupMember: async (a, g) => g === 'finance' && a.user_id === 'u-finance',
});
describe('能力授权隔离、验证和固定版本', () => {
  beforeAll(async () => {
    await installBuiltinCapabilities(db.db, tenant, BUILTIN_CAPABILITIES);
  });
  afterAll(async () => {
    for (const table of [
      'outbox_events',
      'action_audit',
      'action_attempts',
      'action_receipts',
      'action_items',
    ])
      await db.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    await db.db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`DELETE FROM actions WHERE tenant_id=${tenant}`);
      await tx.execute(
        sql`DELETE FROM confirmations WHERE tenant_id=${tenant}`,
      );
    });
    for (const table of [
      'skill_audit_events',
      'skill_invocations',
      'skill_publications',
      'skill_activations',
      'skill_grants',
      'skill_reviews',
      'skill_validation_runs',
      'skill_versions',
      'skills',
      'durable_jobs',
      'insights_commands',
      'integration_capability_tests',
      'integration_capability_versions',
      'integration_capabilities',
      'integration_connectors',
    ])
      await db.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    await db.close();
  });
  it('五共享能力可发现，财务私有能力不可枚举；use不授予源码', async () => {
    await service.seedBuiltinSkills(tenant, {
      owner_id: 'seed-owner',
      private_owner_id: 'u-finance',
      reviewer_id: 'seed-reviewer',
      finance_group_id: 'finance',
    });
    const list = await service.listVisibleSkills(actor, {});
    expect(list.items).toHaveLength(5);
    expect(
      (await service.listVisibleSkills(actor, { q: '财务专用' })).items,
    ).toEqual([]);
    await expect(
      service.getSkill(actor, 'skill-finance-private'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.getSkillSource(actor, 'skill-analytics', 'skill-analytics-v1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.getSkillSource(
        admin,
        'skill-finance-private',
        'skill-finance-private-v1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.getSkillSource(
        { ...admin, user_id: 'seed-owner' },
        'skill-finance-private',
        'skill-finance-private-v1',
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS count FROM skill_reviews WHERE tenant_id=${tenant} AND skill_version_id='skill-finance-private-v1'`,
        )
      ).rows[0],
    ).toEqual({ count: 0 });
  });
  it('模型未配置时验证blocked，私人能力不可假激活', async () => {
    const s = await service.createSkill(
      actor,
      { slug: `mine-${randomUUID()}`, title: '私人能力', summary: '测试' },
      randomUUID(),
    );
    const builtin = await service.getSkillSource(
      { ...actor, user_id: 'seed-owner' },
      'skill-knowledge',
      'skill-knowledge-v1',
    );
    const v = await service.saveVersion(
      actor,
      s.id,
      {
        expected_version: s.version,
        manifest: builtin.manifest,
        markdown: builtin.markdown,
      },
      randomUUID(),
    );
    const validation = await service.validateVersion(
      actor,
      s.id,
      v.id,
      { expected_version: v.version },
      randomUUID(),
    );
    await service.processValidationJob(validation.job_id);
    const state = await service.getValidation(
      actor,
      s.id,
      validation.validation_id,
    );
    expect(state.status).toBe('blocked');
    await expect(
      service.activatePersonalVersion(
        actor,
        s.id,
        {
          expected_version: s.version + 1,
          version_id: v.id,
          selection_policy: 'pin',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
  });
  it('声明脚本与外部schema在保存阶段拒绝', async () => {
    const s = await service.createSkill(
      actor,
      { slug: `bad-${randomUUID()}`, title: '不安全能力', summary: '测试' },
      randomUUID(),
    );
    const builtin = await service.getSkillSource(
      { ...actor, user_id: 'seed-owner' },
      'skill-knowledge',
      'skill-knowledge-v1',
    );
    await expect(
      service.saveVersion(
        actor,
        s.id,
        {
          expected_version: s.version,
          manifest: {
            ...builtin.manifest,
            input_schema: { $ref: 'https://untrusted.example/schema.json' },
          },
          markdown: builtin.markdown,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.saveVersion(
        actor,
        s.id,
        {
          expected_version: s.version,
          manifest: builtin.manifest,
          markdown: builtin.markdown + '\n<script>alert(1)</script>',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('确定性验证端口下固定v1不热升级，停用阻断等待续接', async () => {
    const configured = createSkillService(db.db, {
      freshActor: async (a) => a,
      isGroupMember: async () => false,
      validateExamples: async () => ({
        checks: [{ name: 'controlled_examples', status: 'passed' }],
        test_run_ids: [],
      }),
      validateModel: async () => ({
        passed: true,
        test_run_ids: ['deterministic-contract-adapter-run'],
      }),
    });
    const s = await configured.createSkill(
        actor,
        { slug: `runtime-${randomUUID()}`, title: '固定版本', summary: '测试' },
        randomUUID(),
      ),
      source = await service.getSkillSource(
        { ...actor, user_id: 'seed-owner' },
        'skill-knowledge',
        'skill-knowledge-v1',
      );
    const v1 = await configured.saveVersion(
      actor,
      s.id,
      {
        expected_version: 1,
        manifest: source.manifest,
        markdown: source.markdown,
      },
      randomUUID(),
    );
    const j1 = await configured.validateVersion(
      actor,
      s.id,
      v1.id,
      { expected_version: 1 },
      randomUUID(),
    );
    await configured.processValidationJob(j1.job_id);
    await configured.activatePersonalVersion(
      actor,
      s.id,
      { expected_version: 2, version_id: v1.id, selection_policy: 'pin' },
      randomUUID(),
    );
    const selection = await configured.resolve(actor, {
        message: '使用',
        explicit_version_id: v1.id,
      }),
      frozen = await configured.freezeForRun(actor, 'frozen-run', selection);
    const v2 = await configured.saveVersion(
        actor,
        s.id,
        {
          expected_version: 2,
          manifest: source.manifest,
          markdown: source.markdown + '\n版本二补充。',
        },
        randomUUID(),
      ),
      j2 = await configured.validateVersion(
        actor,
        s.id,
        v2.id,
        { expected_version: 1 },
        randomUUID(),
      );
    await configured.processValidationJob(j2.job_id);
    await configured.activatePersonalVersion(
      actor,
      s.id,
      { expected_version: 3, version_id: v2.id, selection_policy: 'pin' },
      randomUUID(),
    );
    const ctx = {
      actor,
      run_id: 'frozen-run',
      lease_epoch: 1,
      selected_skill_version_id: v1.id,
      allowed_capability_versions: frozen.capability_versions,
      deadline_at: new Date(Date.now() + 60000).toISOString(),
    };
    expect(await configured.resolveSkillCapabilities(ctx)).toEqual([
      'finance.knowledge.search@1.0.0',
    ]);
    expect(frozen.skill_version_id).toBe(v1.id);
    expect(
      (await configured.getFrozenForRun(actor, 'frozen-run'))?.skill_version_id,
    ).toBe(v1.id);
    await configured.disable(
      actor,
      s.id,
      { expected_version: 3, reason: '停止新调用' },
      randomUUID(),
    );
    await expect(configured.assertUsable(ctx, frozen)).rejects.toMatchObject({
      code: 'REVALIDATION_REQUIRED',
    });
  });
  it('独立审查与统一确认发布，同键只产生一次publication', async () => {
    const actions = createActionService(db.db, {
      signingSecret: 'skill-publication-integration-signing-secret-32',
      freshActor: async (a) => a,
      assertResourceAccess: async () => {},
    });
    const configured = createSkillService(db.db, {
      actions,
      freshActor: async (a) => a,
      isGroupMember: async () => false,
      assertManageScope: async () => {},
      validateExamples: async () => ({
        checks: [{ name: 'controlled_examples', status: 'passed' }],
        test_run_ids: [],
      }),
      validateModel: async () => ({
        passed: true,
        test_run_ids: ['deterministic-contract-adapter-run'],
      }),
    });
    const s = await configured.createSkill(
        actor,
        { slug: `publish-${randomUUID()}`, title: '共享发布', summary: '测试' },
        randomUUID(),
      ),
      source = await service.getSkillSource(
        { ...actor, user_id: 'seed-owner' },
        'skill-knowledge',
        'skill-knowledge-v1',
      );
    const v = await configured.saveVersion(
        actor,
        s.id,
        {
          expected_version: 1,
          manifest: source.manifest,
          markdown: source.markdown,
        },
        randomUUID(),
      ),
      job = await configured.validateVersion(
        actor,
        s.id,
        v.id,
        { expected_version: 1 },
        randomUUID(),
      );
    await configured.processValidationJob(job.job_id);
    const scope = { scope: 'tenant' },
      grants = [{ subject_type: 'tenant', subject_id: tenant, action: 'use' }];
    await expect(
      configured.requestReview(
        actor,
        s.id,
        {
          expected_version: 2,
          version_id: v.id,
          requested_scope: scope,
          grants,
          reviewer_id: actor.user_id,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const review = await configured.requestReview(
      actor,
      s.id,
      {
        expected_version: 2,
        version_id: v.id,
        requested_scope: scope,
        grants,
        reviewer_id: 'independent-reviewer',
      },
      randomUUID(),
    );
    await configured.decideReview(
      { ...actor, user_id: 'independent-reviewer' },
      s.id,
      review.review_id,
      { expected_version: 1, decision: 'approved', reason: '已检查示例和范围' },
      randomUUID(),
    );
    const publishKey = randomUUID(),
      intent = {
        expected_version: 2,
        version_id: v.id,
        review_id: review.review_id,
      },
      prepared = await configured.preparePublication(
        actor,
        s.id,
        intent,
        publishKey,
      ),
      browser = await actions.getReview(actor, prepared.confirmation_id, {
        channel: 'browser',
      });
    const result = await actions.confirmAction(
      actor,
      prepared.confirmation_id,
      {
        expected_version: browser.version,
        summary_hash: browser.summary_hash,
        confirmation_token: browser.confirmation_token!,
      },
    );
    expect(result.state).toBe('succeeded');
    expect(
      (await configured.preparePublication(actor, s.id, intent, publishKey))
        .action_id,
    ).toBe(prepared.action_id);
    expect(
      (
        await db.db.execute(
          sql`SELECT count(*)::int AS count FROM skill_publications WHERE tenant_id=${tenant} AND skill_id=${s.id}`,
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    const user = {
      ...actor,
      user_id: 'recipient',
      permissions: ['skill.use'] as ActorContext['permissions'],
    };
    expect((await configured.getSkill(user, s.id)).usable).toBe(true);
    await expect(
      configured.getSkillSource(user, s.id, v.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
