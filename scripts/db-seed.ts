import { loadConfig } from '@caixiaozhi/platform/config';
import {
  checkDatabaseReady,
  createDatabase,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { assertMaintenanceAllowed } from '@caixiaozhi/platform/maintenance';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
assertMaintenanceAllowed(
  process.env.APP_MODE === 'production' ? 'production' : 'demo',
);
const config = loadConfig();
assertMaintenanceAllowed(config.appMode);
if (config.appMode !== 'demo' || !config.demoAccessEnabled)
  throw new Error(
    '完整演示初始化需要 APP_MODE=demo 与显式 DEMO_ACCESS_ENABLED=true。',
  );
const database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
try {
  await checkDatabaseReady(database);
  await storage.checkReady();
  const application = createConfiguredApplication({
    database,
    storage,
    config,
  });
  const result = await application.demo.initialize();
  process.stdout.write(
    JSON.stringify({
      event: 'demo.initialized',
      generation: result.generation,
      lifecycle: result.lifecycle,
      seed_version: result.seed_version,
    }) + '\n',
  );
} finally {
  storage.close();
  await database.close();
}
