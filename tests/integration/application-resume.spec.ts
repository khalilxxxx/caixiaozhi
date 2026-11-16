import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@caixiaozhi/contracts';
import { CheckpointSchema } from '@caixiaozhi/contracts/runs';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';

const config = {
  ...loadConfig(),
  cookieSecure: false,
  appMode: 'demo' as const,
  demoAccessEnabled: true,
  logLevel: 'silent' as const,
};
const database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
const tenant = `resume-${randomUUID()}`,
  envId = `env-${tenant}`;
const services = createConfiguredApplication({
  database,
  storage,
  config,
  demoTenantId: tenant,
  demoEnvironmentId: envId,
});
let li: ActorContext, zhang: ActorContext;
async function start(actor: ActorContext) {
  const thread = await services.assistant.createThread(
    actor,
    {
      title: '真实应用续接回归',
      initial_message: {
        content: '等待真实业务结果后继续。',
        client_message_id: randomUUID(),
      },
    },
    randomUUID(),
  );
  const lease = await services.runs.claimRun('application-resume-worker');
  expect(lease?.run.id).toBe(thread.run_id);
  return { thread, lease: lease! };
}
describe('应用总装确认与领域任务真实续接', () => {
  beforeAll(async () => {
    await services.demo.initialize();
    const login = async (user: string) => {
      const session = await services.identity.loginDemo(user, undefined, {
        tenantId: tenant,
        environmentId: envId,
        generation: 1,
      });
      return services.identity.getActor(session.session_token);
    };
    li = await login('u-li');
    zhang = await login('u-zhang');
  }, 30000);
  afterAll(async () => {
    storage.close();
    await database.close();
  });
  it('未确认不能唤醒；浏览器受保护确认写入真实消息回执后续接同run并投影回执卡', async () => {
    const { thread, lease } = await start(li);
    const ref = (await services.documents.get(li, 'oa_request', 'oa-001'))
      .resource_ref;
    const draft = await services.messages.save(
      li,
      null,
      {
        message_kind: 'reminder',
        subject: '续接回归通知',
        body: '真实确认后发送的演示站内通知。',
        recipient_ids: ['u-li'],
        resource_ref: ref,
      },
      randomUUID(),
    );
    const confirmation = await services.actions.prepareAction(li, {
      action: 'oa.message.send',
      resource_refs: [ref],
      args: {
        message_draft_id: draft.id,
        expected_draft_version: draft.version,
        recipient_ids: ['u-li'],
        subject: draft.subject,
        body: draft.body,
      },
      idempotency_key: randomUUID(),
      run_id: lease.run.id,
    });
    await services.runs.appendEvent(
      lease.run.id,
      lease.lease_epoch,
      'confirmation.required',
      confirmation,
    );
    const checkpoint = await services.runs.saveCheckpoint(
      lease.run.id,
      lease.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_confirmation',
        pending_confirmation_id: confirmation.confirmation_id,
        action_ids: [confirmation.action_id],
        resource_refs: [ref],
      }),
    );
    await services.wakeWaitingRuns();
    const waiting = await services.runs.getRun(li, lease.run.id);
    expect(waiting.status).toBe('waiting_confirmation');
    await expect(
      services.runs.resumeRun(
        li,
        lease.run.id,
        {
          expected_version: waiting.version,
          checkpoint_id: checkpoint,
          input: { confirmed: true },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'REVALIDATION_REQUIRED' });
    expect(
      (await services.runs.events(li, lease.run.id, 0)).some(
        (event) =>
          event.type === 'confirmation.required' &&
          (event.payload as { confirmation_id?: string }).confirmation_id ===
            confirmation.confirmation_id,
      ),
    ).toBe(true);
    const review = await services.actions.getReview(
      li,
      confirmation.confirmation_id,
      { channel: 'browser' },
    );
    expect(review.confirmation_token).toBeTruthy();
    const action = await services.actions.confirmAction(
      li,
      confirmation.confirmation_id,
      {
        expected_version: review.version,
        summary_hash: review.summary_hash,
        confirmation_token: review.confirmation_token!,
      },
    );
    expect(action.state).toBe('succeeded');
    expect(action.items[0]?.receipt?.outcome).toBe('succeeded');
    expect(
      (
        await database.pool.query(
          'SELECT m.state,count(d.message_id)::int deliveries FROM demo_messages m LEFT JOIN message_deliveries d ON d.tenant_id=m.tenant_id AND d.message_id=m.id WHERE m.tenant_id=$1 AND m.id=$2 GROUP BY m.state',
          [tenant, draft.id],
        )
      ).rows[0],
    ).toEqual({ state: 'sent', deliveries: 1 });
    await services.wakeWaitingRuns();
    expect((await services.runs.getRun(li, lease.run.id)).status).toBe(
      'queued',
    );
    await services.wakeWaitingRuns();
    const resumed = await services.runs.claimRun('application-resume-worker');
    expect(resumed?.run.id).toBe(lease.run.id);
    await services.buildRuntimeInput(resumed!);
    const snapshot = await services.assistant.snapshot(li, thread.thread.id);
    const receiptCard = snapshot.cards.find(
      (card) => 'type' in card && card.type === 'action_result',
    );
    expect(
      receiptCard && 'payload' in receiptCard ? receiptCard.payload : null,
    ).toMatchObject({
      action_ids: [action.id],
      receipt_ids: [action.items[0]!.receipt!.id],
      outcomes: [{ action_id: action.id, outcome: 'succeeded' }],
    });
    await services.runs.finishRun(
      lease.run.id,
      resumed!.lease_epoch,
      'succeeded',
    );
  });
  it('真实预审终态唤醒同run，错代和已取消等待不能被迟到结果复活', async () => {
    const { thread, lease } = await start(zhang);
    const accepted = await services.finance.startPreaudit(
      zhang,
      {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-001', version: 1 }],
      },
      randomUUID(),
      lease.run.id,
    );
    await services.runs.saveCheckpoint(
      lease.run.id,
      lease.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_domain_job',
        waiting_job_ref: {
          id: accepted.task_id,
          kind: 'preaudit.task',
          generation: 1,
        },
      }),
    );
    await services.wakeWaitingRuns();
    expect(await services.runs.getRun(zhang, lease.run.id)).toMatchObject({
      status: 'running',
      runtime_active: false,
    });
    for (
      let n = 0;
      n < 20 &&
      (await services.finance.processNextJob('application-resume-finance'));
      n++
    ) {}
    const result = await services.finance.getTask(zhang, accepted.task_id);
    expect(['completed', 'partial_failed']).toContain(result.task.status);
    await services.wakeWaitingRuns();
    expect((await services.runs.getRun(zhang, lease.run.id)).status).toBe(
      'queued',
    );
    const resumed = await services.runs.claimRun('application-resume-worker');
    expect(resumed?.run.id).toBe(lease.run.id);
    await services.buildRuntimeInput(resumed!);
    expect(
      (await services.assistant.snapshot(zhang, thread.thread.id)).cards.some(
        (card) => 'type' in card && card.type === 'preaudit_summary',
      ),
    ).toBe(true);
    await services.runs.finishRun(
      lease.run.id,
      resumed!.lease_epoch,
      'succeeded',
    );
    const wrong = await start(zhang);
    await services.runs.saveCheckpoint(
      wrong.lease.run.id,
      wrong.lease.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_domain_job',
        waiting_job_ref: {
          id: accepted.task_id,
          kind: 'preaudit.task',
          generation: 2,
        },
      }),
    );
    await services.wakeWaitingRuns();
    expect((await services.runs.getRun(zhang, wrong.lease.run.id)).status).toBe(
      'running',
    );
    const wrongState = await services.runs.getRun(zhang, wrong.lease.run.id);
    await services.runs.cancelRun(
      zhang,
      wrong.lease.run.id,
      { expected_version: wrongState.version, reason: '终止错代测试' },
      randomUUID(),
    );
    const cancelled = await start(zhang);
    const point = await services.runs.saveCheckpoint(
      cancelled.lease.run.id,
      cancelled.lease.lease_epoch,
      CheckpointSchema.parse({
        stage: 'waiting_domain_job',
        waiting_job_ref: {
          id: accepted.task_id,
          kind: 'preaudit.task',
          generation: 1,
        },
      }),
    );
    const current = await services.runs.getRun(zhang, cancelled.lease.run.id);
    await services.runs.cancelRun(
      zhang,
      cancelled.lease.run.id,
      { expected_version: current.version, reason: '用户终止' },
      randomUUID(),
    );
    await services.wakeWaitingRuns();
    expect(
      await services.runs.completeDomainJob(
        zhang,
        cancelled.lease.run.id,
        point,
        { id: accepted.task_id, generation: 1 },
      ),
    ).toBe(false);
    expect(
      (await services.runs.getRun(zhang, cancelled.lease.run.id)).status,
    ).toBe('cancelled');
  });
});
