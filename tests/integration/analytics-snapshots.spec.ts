import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { ActorContext } from '@caixiaozhi/contracts';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createStorage } from '@caixiaozhi/platform/storage';
import {
  createAnalyticsService,
  percentageChange,
} from '../../packages/insights/src/analytics.js';
const db = createDatabase(loadConfig().databaseUrl),
  tenant = `analytics-${randomUUID()}`;
const actor: ActorContext = {
  tenant_id: tenant,
  user_id: 'u-test',
  roles: ['manager'],
  department_ids: ['dept-sales'],
  permissions: ['analytics.query', 'analytics.export'],
  authz_version: 1,
  session_id: 's',
  invocation_origin: 'interactive',
  delegation_id: null,
};
let departments = ['dept-sales'];
const storage = createStorage(loadConfig().s3);
const service = createAnalyticsService(db.db, {
  storage,
  freshActor: async (a) => a,
  getResourceScope: async () => ({
    tenant_id: tenant,
    owner_ids: [],
    department_ids: departments,
  }),
  businessDate: async () => '2026-11-05',
});
const plan = {
  metric: 'expense.completed_amount',
  period: {
    from: '2026-11-01',
    to_exclusive: '2026-11-06',
    timezone: 'Asia/Shanghai',
    date_basis: 'completed_at',
    compare_to: { from: '2026-10-01', to_exclusive: '2026-11-01' },
  },
  dimensions: ['applicant'],
  filters: { scope: 'department', department_ids: ['dept-sales'] },
};
describe('确定性分析快照和当前授权', () => {
  beforeAll(async () => {
    await db.db.execute(
      sql`INSERT INTO identity_environments(tenant_id,id,generation) VALUES(${tenant},${tenant},1)`,
    );
    await db.db.execute(
      sql`INSERT INTO organizations(tenant_id,id,name,parent_id,state) VALUES(${tenant},'dept-sales','测试销售',NULL,'active')`,
    );
    for (const id of ['u-test', 'u-li', 'u-wang'])
      await db.db.execute(
        sql`INSERT INTO identities(tenant_id,id,external_subject,display_name,department_id,position,state) VALUES(${tenant},${id},${id},${id},'dept-sales','测试','active')`,
      );
    for (const [id, owner, amount, date] of [
      ['nov-li', 'u-li', '350000', '2026-11-05T02:00:00Z'],
      ['nov-wang', 'u-wang', '240000', '2026-11-05T02:00:00Z'],
      ['oct-li', 'u-li', '100000', '2026-10-05T02:00:00Z'],
      ['oct-wang', 'u-wang', '80000', '2026-10-05T02:00:00Z'],
    ] as const) {
      await db.db.execute(
        sql`INSERT INTO expense_claims(tenant_id,id,owner_id,department_id,state,title,total_minor,submitted_at,completed_at) VALUES(${tenant},${id},${owner},'dept-sales','completed',${id},${amount},'2026-11-02T02:00:00Z',${date})`,
      );
    }
  });
  afterAll(async () => {
    const artifacts = await db.db.execute(
      sql`SELECT object_key FROM analysis_artifacts WHERE tenant_id=${tenant}`,
    );
    for (const r of artifacts.rows)
      await storage.deleteObject(String(r.object_key));
    for (const table of [
      'analysis_artifacts',
      'analysis_report_versions',
      'analysis_reports',
      'analysis_facts',
      'analysis_snapshots',
      'analysis_requests',
      'durable_jobs',
      'insights_commands',
      'uploaded_files',
      'expense_claims',
      'identities',
      'organizations',
      'identity_environments',
    ])
      await db.db.execute(
        sql.raw(`DELETE FROM ${table} WHERE tenant_id='${tenant}'`),
      );
    storage.close();
    await db.close();
  });
  it('590000/180000/410000/227.78精确计算，查询真实排队并去重', async () => {
    const key = randomUUID(),
      query = await service.query(actor, plan, key);
    expect(query.status).toBe('queued');
    expect((await service.query(actor, plan, key)).request_id).toBe(
      query.request_id,
    );
    await service.processJob(query.job_id);
    const request = await service.getQuery(actor, query.request_id),
      snapshot = await service.getSnapshot(actor, request.snapshot_id!);
    expect(snapshot.total).toEqual({ amount_minor: '590000', currency: 'CNY' });
    expect(snapshot.comparison).toMatchObject({
      base: { amount_minor: '180000' },
      delta: { amount_minor: '410000' },
      rate_percent: '227.78',
    });
    expect(snapshot.rows.map((r) => r.value)).toEqual(['350000', '240000']);
  });
  it('旧快照下钻保留原事实并标stale，撤权后拒绝正文', async () => {
    const q = await service.query(actor, plan, randomUUID());
    await service.processJob(q.job_id);
    const request = await service.getQuery(actor, q.request_id),
      id = request.snapshot_id!;
    await db.db.execute(
      sql`UPDATE expense_claims SET total_minor=999999,version=version+1 WHERE tenant_id=${tenant} AND id='nov-li'`,
    );
    const snapshot = await service.getSnapshot(actor, id);
    expect(snapshot.freshness).toBe('stale');
    expect(snapshot.total).toMatchObject({ amount_minor: '590000' });
    const rows = await service.drillSnapshot(actor, id, {});
    expect(rows.items.reduce((v, r) => v + BigInt(r.amount_minor), 0n)).toBe(
      590000n,
    );
    departments = [];
    await expect(service.getSnapshot(actor, id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    departments = ['dept-sales'];
  });
  it('无权部门和SQL字段均拒绝；基期零明确未知比率', async () => {
    await expect(
      service.query(actor, { ...plan, sql: 'SELECT *' }, randomUUID()),
    ).rejects.toBeTruthy();
    await expect(
      service.query(
        actor,
        {
          ...plan,
          filters: { scope: 'department', department_ids: ['dept-tech'] },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(percentageChange(100n, 0n)).toEqual({
      rate_percent: null,
      reason: 'zero_baseline',
    });
  });
  it('报告事实锁定、S3真实导出去重及撤权下载拒绝', async () => {
    const q = await service.query(actor, plan, randomUUID());
    await service.processJob(q.job_id);
    const request = await service.getQuery(actor, q.request_id),
      snapshot = await service.getSnapshot(actor, request.snapshot_id!);
    const created = await service.createReport(
      actor,
      { analysis_snapshot_id: snapshot.id, template: 'monthly_expense' },
      randomUUID(),
    );
    await service.processJob(created.job_id);
    const report = await service.getReport(actor, created.report_id);
    await expect(
      service.patchReport(
        actor,
        created.report_id,
        {
          expected_version: Number(report.version),
          editable_blocks: { locked_metric: '600000' },
        },
        randomUUID(),
      ),
    ).rejects.toBeTruthy();
    await service.patchReport(
      actor,
      created.report_id,
      {
        expected_version: Number(report.version),
        editable_blocks: { user_note: '<script>alert(1)</script>' },
      },
      randomUUID(),
    );
    const current = await service.getReport(actor, created.report_id),
      key = randomUUID(),
      input = {
        expected_version: Number(current.version),
        format: 'html',
        freshness_choice: 'as_recorded',
      },
      artifact = await service.exportReport(
        actor,
        created.report_id,
        input,
        key,
      );
    expect(
      (await service.exportReport(actor, created.report_id, input, key))
        .artifact_id,
    ).toBe(artifact.artifact_id);
    await service.processJob(artifact.job_id);
    const downloaded = await service.downloadArtifact(
        actor,
        artifact.artifact_id,
      ),
      html = Buffer.from(downloaded.bytes).toString();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain(snapshot.id);
    expect(
      (await service.getArtifact(actor, artifact.artifact_id)).downloadable,
    ).toBe(true);
    departments = [];
    await expect(
      service.downloadArtifact(actor, artifact.artifact_id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    departments = ['dept-sales'];
  });
});
