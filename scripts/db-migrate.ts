import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
import { migrateDatabase } from '@caixiaozhi/platform/migrations';

const database = createDatabase(loadConfig().databaseUrl);
try {
  const result = await migrateDatabase(database);
  console.log(`数据库迁移完成，本次应用 ${result.applied.length} 个迁移。`);
} finally {
  await database.close();
}
