import { loadConfig } from '@caixiaozhi/platform/config';
import {
  createDatabase,
  checkDatabaseReady,
} from '@caixiaozhi/platform/database';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createConfiguredApplication } from '@caixiaozhi/application/demo';
import { createProductApp } from './product.js';

async function main() {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  const storage = createStorage(config.s3);
  const services = createConfiguredApplication({ database, storage, config });
  const app = createProductApp(config, services, {
    database: async () => {
      await checkDatabaseReady(database);
    },
    storage: () => storage.checkReady(),
  });
  app.addHook('onClose', async () => {
    storage.close();
    await database.close();
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: 'api.stopping' }, 'API 正在退出');
    await app.close();
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
  } catch {
    app.log.error(
      { event: 'api.start_failed' },
      'API 启动失败，请检查端口与配置',
    );
    await app.close();
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith('环境配置无效')
      ? error.message
      : 'API 启动失败，请检查环境配置。';
  process.stderr.write(
    JSON.stringify({ level: 'error', event: 'api.start_failed', message }) +
      '\n',
  );
  process.exitCode = 1;
});
