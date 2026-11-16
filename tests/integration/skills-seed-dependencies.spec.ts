import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { AppError } from '@caixiaozhi/platform/errors';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  BUILTIN_CAPABILITIES,
  installBuiltinCapabilities,
} from '@caixiaozhi/integrations';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createSkillService } from '../../packages/insights/src/skills.js';
import { createSkillValidationPorts } from '../../packages/application/src/skill-validation.js';

const database = createDatabase(loadConfig().databaseUrl),
  tenant = `skill-seed-dependencies-${randomUUID()}`,
  identity = createIdentityService(database, {
    sessionSecret: 'skill-seed-dependencies-integration-secret-long-enough',
    appMode: 'demo',
    demoAccessEnabled: true,
  });
let author: ActorContext,
  blockedReason: unknown = null;
const ports = createSkillValidationPorts({
  database,
  freshActor: (actor) => identity.requireCurrentActor(actor),
  appMode: 'test',
  modelConfigured: false,
  executeTool: async () => {
    throw new Error('缺模型不得开始工具试运行。');
  },
});
const skills = createSkillService(database.db, {
  freshActor: (actor) => identity.requireCurrentActor(actor),
  isGroupMember: (actor, group, user) =>
    identity.isGroupMember(actor, group, user),
  ...ports,
  validateExamples: async (actor, skill) => {
    try {
      return await ports.validateExamples!(actor, skill);
    } catch (error) {
      blockedReason = error instanceof AppError ? error.details?.reason : null;
      throw error;
    }
  },
});
const seed = () =>
  skills.seedBuiltinSkills(tenant, {
    owner_id: 'u-liu',
    reviewer_id: 'u-zhang',
    private_owner_id: 'u-liu',
    finance_group_id: 'g-finance-demo',
  });

describe('新环境Skill种子精确依赖已发布能力版本', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    await installBuiltinCapabilities(database.db, tenant, BUILTIN_CAPABILITIES);
    await seed();
    const session = await identity.loginDemo('u-liu', undefined, {
      tenantId: tenant,
      environmentId: tenant,
      generation: 1,
    });
    author = await identity.getActor(session.session_token);
  });
  afterAll(async () => {
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
      'identity_environments',
    ])
      await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
        tenant,
      ]);
    await database.close();
  });
  it('全部required工具都有精确published版本及enabled连接器，重复seed不改内容', async () => {
    const actionStatus = await database.pool.query(
      "SELECT definition->>'id' id,semver FROM integration_capability_versions WHERE tenant_id=$1 AND definition->>'name'='finance.action.status'",
      [tenant],
    );
    expect(actionStatus.rows).toEqual([
      { id: 'finance.action.status@1.1.0', semver: '1.1.0' },
    ]);
    const dependencies = await database.pool.query(
      `SELECT s.skill_id,t.tool->>'capability_version_id' version_id,
      c.status capability_status,v.published_at,con.status connector_status
      FROM skill_versions s CROSS JOIN LATERAL jsonb_array_elements(s.manifest_json->'tools') t(tool)
      LEFT JOIN integration_capability_versions v ON v.tenant_id=s.tenant_id AND v.definition->>'id'=t.tool->>'capability_version_id'
      LEFT JOIN integration_capabilities c ON c.tenant_id=v.tenant_id AND c.id=v.capability_id
      LEFT JOIN integration_connectors con ON con.tenant_id=v.tenant_id AND con.id=v.tenant_id||':'||(v.definition->>'connector_id')
      WHERE s.tenant_id=$1 AND (t.tool->>'required')::boolean ORDER BY s.skill_id,version_id`,
      [tenant],
    );
    expect(new Set(dependencies.rows.map((row) => row.skill_id)).size).toBe(6);
    expect(
      dependencies.rows.filter(
        (row) =>
          row.capability_status !== 'published' ||
          !row.published_at ||
          row.connector_status !== 'enabled',
      ),
    ).toEqual([]);
    const before = await database.pool.query(
      'SELECT * FROM skill_versions WHERE tenant_id=$1 ORDER BY id',
      [tenant],
    );
    await seed();
    const after = await database.pool.query(
      'SELECT * FROM skill_versions WHERE tenant_id=$1 ORDER BY id',
      [tenant],
    );
    expect(after.rows).toEqual(before.rows);
  });
  it('规则Skill真实验证越过依赖检查后才因MODEL_NOT_CONFIGURED明确blocked', async () => {
    const source = await skills.getSkillSource(
        author,
        'skill-rules',
        'skill-rules-v1',
      ),
      queued = await skills.validateVersion(
        author,
        'skill-rules',
        'skill-rules-v1',
        { expected_version: source.version },
        randomUUID(),
      );
    expect(
      await skills.processValidationJob(
        queued.job_id,
        'seed-dependency-regression',
      ),
    ).toBe(true);
    const validation = await skills.getValidation(
      author,
      'skill-rules',
      queued.validation_id,
    );
    expect(validation).toMatchObject({
      status: 'blocked',
      error_code: 'DEPENDENCY_UNAVAILABLE',
      synthetic: false,
      test_run_ids: [],
    });
    expect(validation.checks).toContainEqual({
      name: 'capabilities',
      status: 'passed',
    });
    expect(blockedReason).toBe('MODEL_NOT_CONFIGURED');
    const job = await database.pool.query(
      'SELECT status,error_code FROM durable_jobs WHERE tenant_id=$1 AND id=$2',
      [tenant, queued.job_id],
    );
    expect(job.rows).toEqual([
      { status: 'failed', error_code: 'DEPENDENCY_UNAVAILABLE' },
    ]);
  });
});
