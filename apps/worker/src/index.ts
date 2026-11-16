import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  createDatabase,
  checkDatabaseReady,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { AppError } from '@caixiaozhi/platform/errors';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
import { createWorkerRunner } from './runner/index.js';
import { createReceiptReconciler } from './reconciler/index.js';

async function main() {
  const config = loadConfig(),
    logger = pino({
      level: config.logLevel,
      base: { service: 'worker', app_mode: config.appMode },
    });
  const database = createDatabase(config.databaseUrl),
    storage = createStorage(config.s3);
  const services = createConfiguredApplication({ database, storage, config });
  const workerId = `worker-${randomUUID()}`;
  const claimScope = async () =>
    config.appMode === 'demo'
      ? {
          tenant_id: (
            await services.demo.gate.currentTenant(services.demoEnvironmentId)
          ).tenant_id,
        }
      : {};
  const runner = createWorkerRunner({
    runs: services.runs,
    runtime: services.runtime,
    freshActor: services.freshActor,
    buildInput: services.buildRuntimeInput,
    workerId,
    concurrency: 2,
    claimScope,
    log: (event) => logger.info(event),
  });
  const receiptReconciler = createReceiptReconciler({
    database,
    actions: services.actions,
    runs: services.runs,
  });
  let stopping = false,
    busy = false,
    lastSchedule = 0;
  async function tick() {
    if (stopping || busy) return;
    busy = true;
    try {
      if (config.appMode === 'demo') {
        await services.demo.runNextReset(workerId);
        await services.demo.processNextSummaryTrigger(workerId);
      }
      const scope = await claimScope();
      await services.finance.processNextJob(workerId, scope);
      const job = await services.queue.claim(
        workerId,
        ['expense.ocr', 'travel.proposal', 'expense.proposal'],
        undefined,
        scope,
      );
      if (job) {
        const heartbeat = setInterval(() => {
          void services.queue
            .heartbeat(job.id, workerId, job.lease_epoch)
            .catch(() => {});
        }, 10000);
        try {
          if (job.kind === 'expense.ocr')
            await services.invoices.processJob(job);
          else if (job.kind === 'expense.proposal')
            await services.expenseProposals.processJob(job);
          else await services.proposals.processJob(job);
          await services.queue.finish(
            job.id,
            workerId,
            job.lease_epoch,
            'succeeded',
          );
        } catch (error) {
          await services.queue.finish(
            job.id,
            workerId,
            job.lease_epoch,
            'failed',
            error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
          );
        } finally {
          clearInterval(heartbeat);
        }
      }
      // Insights各服务自行CAS领取，不能先被通用队列claim。
      const insights = await database.pool.query(
        "SELECT id,kind FROM durable_jobs WHERE owner_module='insights' AND ($1::text IS NULL OR tenant_id=$1) AND ready_at<=clock_timestamp() AND (status='ready' OR (status='running' AND lease_until<clock_timestamp())) ORDER BY ready_at,id LIMIT 2",
        [scope.tenant_id ?? null],
      );
      for (const job of insights.rows) {
        if (job.kind === 'skills.validate')
          await services.skills.processValidationJob(job.id, workerId);
        else await services.analytics.processJob(job.id, workerId);
      }
      if (Date.now() - lastSchedule >= 30000) {
        const at =
          config.appMode === 'demo'
            ? new Date((await services.demo.businessClock()).business_now)
            : new Date();
        await services.memory.scheduleDueSubscriptions(at, 30, {
          tenantId: scope.tenant_id,
        });
        lastSchedule = Date.now();
      }
      await services.wakeWaitingRuns(scope);
      const modelJobs = await database.pool.query(
        "SELECT id FROM durable_jobs WHERE kind='model.generate' AND ($1::text IS NULL OR tenant_id=$1) AND (status='ready' OR (status='running' AND lease_until<clock_timestamp())) ORDER BY ready_at,id LIMIT 1",
        [scope.tenant_id ?? null],
      );
      for (const job of modelJobs.rows)
        await services.generation.processJob(job.id, workerId);
      await services.memory.generateNextDigest(workerId, scope);
      await services.memory.deliverPending(30, scope);
    } catch (error) {
      logger.warn(
        {
          event: 'worker.domain_poll_failed',
          code:
            error instanceof AppError ? error.code : 'DEPENDENCY_UNAVAILABLE',
        },
        '领域任务暂未完成，将按持久状态恢复',
      );
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), 500);
  let reconciliationPending: Promise<void> | undefined;
  const reconciliationTimer = setInterval(() => {
    if (stopping || reconciliationPending) return;
    reconciliationPending = (async () =>
      receiptReconciler.tick(workerId, await claimScope()))()
      .catch(() =>
        logger.warn(
          { event: 'worker.reconciliation_deferred' },
          '原动作回执核实暂未完成',
        ),
      )
      .finally(() => {
        reconciliationPending = undefined;
      });
  }, 1000);
  let scenarioBusy = false;
  const scenarioTimer =
    config.appMode === 'demo'
      ? setInterval(() => {
          if (stopping || scenarioBusy) return;
          scenarioBusy = true;
          void services.scenarios
            .processNext(workerId)
            .catch(() =>
              logger.warn(
                { event: 'demo.journey_poll_failed' },
                '旅程控制任务暂不可用',
              ),
            )
            .finally(() => {
              scenarioBusy = false;
            });
        }, 1000)
      : undefined;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(reconciliationTimer);
    clearInterval(scenarioTimer);
    services.scenarios.stop();
    logger.info({ event: 'worker.stopping' }, '工作进程正在退出');
    await runner.stop();
    await reconciliationPending;
    while (busy || scenarioBusy)
      await new Promise((resolve) => setTimeout(resolve, 25));
    storage.close();
    await database.close();
    logger.info({ event: 'worker.stopped' }, '工作进程已退出');
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  const checks = await Promise.allSettled([
    checkDatabaseReady(database),
    storage.checkReady(),
  ]);
  logger.info(
    {
      event: 'worker.started',
      database: checks[0]?.status === 'fulfilled' ? 'ready' : 'unavailable',
      storage: checks[1]?.status === 'fulfilled' ? 'ready' : 'unavailable',
      dsh: 'sdk-adapter',
      model_configured: Boolean(
        config.dsh.apiKey &&
        config.dsh.model &&
        config.dsh.baseURL &&
        config.dsh.contextWindow,
      ),
    },
    '持久任务工作进程已启动',
  );
  runner.start();
  void tick();
}
main().catch(() => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'worker.start_failed',
      message: '工作进程启动失败，请检查环境配置。',
    }) + '\n',
  );
  process.exitCode = 1;
});
