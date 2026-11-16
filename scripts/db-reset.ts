import { loadConfig } from '@caixiaozhi/platform/config';
import { assertMaintenanceAllowed } from '@caixiaozhi/platform/maintenance';
import { createDatabase } from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
import { randomUUID } from 'node:crypto';
assertMaintenanceAllowed(
  process.env.APP_MODE === 'production' ? 'production' : 'demo',
);
const config = loadConfig();
assertMaintenanceAllowed(config.appMode);
if (config.appMode !== 'demo' || !config.demoAccessEnabled)
  throw new Error(
    '演示重建需要 APP_MODE=demo 与显式 DEMO_ACCESS_ENABLED=true。',
  );
const database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
try {
  const application = createConfiguredApplication({
    database,
    storage,
    config,
  });
  const environment = await application.demo.current();
  const access = await application.demo.gate.currentTenant(
    config.demoEnvironmentId,
  );
  const session = await application.identity.loginDemo('u-zhao', undefined, {
    tenantId: access.tenant_id,
    environmentId: config.demoEnvironmentId,
    generation: access.generation,
  });
  const actor = await application.identity.getActor(session.session_token);
  const job = await application.demo.requestReset(
    actor,
    {
      expected_generation: environment.generation,
      expected_environment_version: environment.version,
      seed_version: 'finance-agent-v1.0',
      scenario_id: 'baseline',
      intent: 'reset_demo_environment',
    },
    randomUUID(),
  );
  for (let n = 0; n < 100; n++) {
    const result = await database.pool.query(
      'SELECT state,phase,error_code FROM demo_reset_jobs WHERE id=$1',
      [job.id],
    );
    const state = result.rows[0];
    if (state?.state === 'succeeded') {
      console.log(
        JSON.stringify({
          event: 'demo.reset',
          job_id: job.id,
          status: state.state,
          generation: (await application.demo.current()).generation,
        }),
      );
      break;
    }
    if (['blocked', 'failed'].includes(state?.state)) {
      console.error(
        JSON.stringify({
          event: 'demo.reset',
          status: state.state,
          phase: state.phase,
          error_code: state.error_code,
        }),
      );
      process.exitCode = 2;
      break;
    }
    await application.demo.runNextReset('demo-reset-cli');
    if (n === 99)
      throw new Error('重建未在受控轮次内完成，请从控制台查看原任务。');
  }
} finally {
  storage.close();
  await database.close();
}
