import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
import type { ActorContext } from '@caixiaozhi/contracts';
const base = loadConfig(),
  config = { ...base, appMode: 'demo' as const, demoAccessEnabled: true },
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
const tenant = `rule-disable-${randomUUID()}`,
  environment = `env-${tenant}`,
  app = createConfiguredApplication({
    database,
    storage,
    config,
    demoTenantId: tenant,
    demoEnvironmentId: environment,
  });
let liu: ActorContext, zhang: ActorContext, li: ActorContext;
async function confirm(actor: ActorContext, id: string) {
  const r = await app.actions.getReview(actor, id, { channel: 'browser' });
  return app.actions.confirmAction(actor, id, {
    expected_version: r.version,
    summary_hash: r.summary_hash,
    confirmation_token: r.confirmation_token!,
  });
}
describe('规则停用通过独立确认动作而非启用参数偷渡', () => {
  beforeAll(async () => {
    await app.demo.initialize();
    const login = async (id: string) => {
      const s = await app.identity.loginDemo(id, undefined, {
        tenantId: tenant,
        environmentId: environment,
        generation: 1,
      });
      return app.identity.getActor(s.session_token);
    };
    liu = await login('u-liu');
    zhang = await login('u-zhang');
    li = await login('u-li');
  }, 30000);
  afterAll(async () => {
    storage.close();
    await database.close();
  });
  it('公司必查覆盖变化写入明确摘要，未确认不改变，确认后提升修订并使旧预审失效', async () => {
    let r = await app.finance.rules.getRule(liu, 'rule-company-lodging');
    const originalName = r.name,
      active = r.versions.find((v: any) => v.id === r.active_version_id);
    r = await app.finance.rules.saveDraft(
      liu,
      r.id,
      r.version,
      {
        name: '尚未发布的分类与标题',
        level: 'company',
        category: 'general',
        dsl_json: active.dsl_json,
        source_kind: active.source_kind,
        source_citation_ids: active.source_citation_ids,
      },
      randomUUID(),
    );
    const task = await app.finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-001', version: 1 }],
      },
      randomUUID(),
    );
    for (
      let i = 0;
      i < 8 &&
      (await app.finance.processNextJob('rule-disable-test', {
        tenant_id: tenant,
      }));
      i++
    ) {}
    const before = await app.finance.getTask(zhang, task.task_id);
    expect(before.items[0]?.result?.group).toBe('low');
    const prepared = await app.actions.prepareAction(liu, {
      action: 'rule.disable',
      resource_refs: [{ type: 'rule', id: r.id, version: r.version }],
      args: { rule_id: r.id, expected_version: r.version },
      idempotency_key: randomUUID(),
    });
    const review = await app.actions.getReview(liu, prepared.confirmation_id, {
      channel: 'browser',
    });
    expect(review.summary).toMatchObject({
      title: '停用审核规则',
      level: 'company',
      rule_name: originalName,
      coverage_before: true,
      coverage_after: false,
    });
    expect(JSON.stringify(review.summary)).toContain('必查');
    expect((await app.finance.rules.getRule(liu, r.id)).active_version_id).toBe(
      r.active_version_id,
    );
    const result = await confirm(liu, prepared.confirmation_id);
    expect(result.state).toBe('succeeded');
    const changed = await app.finance.rules.getRule(liu, r.id);
    expect(changed.lifecycle).toBe('disabled');
    expect(changed.active_version_id).toBeNull();
    expect(changed.version).toBe(r.version + 1);
    const revision = await database.pool.query(
      "SELECT revision FROM finance_revision_guards WHERE tenant_id=$1 AND id='company'",
      [tenant],
    );
    expect(Number(revision.rows[0].revision)).toBeGreaterThan(1);
    const old = await app.finance.getTask(zhang, task.task_id);
    expect(JSON.stringify(old)).toContain('stale');
  });
  it('个人owner可明确停用；普通员工无权停用公司规则，旧版本与非法参数拒绝', async () => {
    const r = await app.finance.rules.getRule(zhang, 'rule-personal-meals');
    const prepared = await app.actions.prepareAction(zhang, {
      action: 'rule.disable',
      resource_refs: [{ type: 'rule', id: r.id, version: r.version }],
      args: { rule_id: r.id, expected_version: r.version },
      idempotency_key: randomUUID(),
    });
    expect((await confirm(zhang, prepared.confirmation_id)).state).toBe(
      'succeeded',
    );
    const company = await app.finance.rules.getRule(
      liu,
      'rule-company-invoice',
    );
    await expect(
      app.actions.prepareAction(li, {
        action: 'rule.disable',
        resource_refs: [
          { type: 'rule', id: company.id, version: company.version },
        ],
        args: { rule_id: company.id, expected_version: company.version },
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      app.actions.prepareAction(liu, {
        action: 'rule.disable',
        resource_refs: [
          { type: 'rule', id: company.id, version: company.version },
        ],
        args: {
          rule_id: company.id,
          expected_version: company.version,
          disable: false,
        },
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
