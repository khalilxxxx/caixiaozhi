import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { assertDatabaseMigrated } from './migrations.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DatabaseExecutor = Database | Transaction;

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    statement_timeout: 2_500,
    max: 10,
    options: '-c timezone=UTC',
    application_name: 'caixiaozhi',
  });
  pool.on('error', () => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        event: 'database.idle_connection_error',
        message: '数据库空闲连接已断开，后续请求将重新连接。',
      }) + '\n',
    );
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;

export async function checkDatabaseReady(
  database: DatabaseConnection,
): Promise<void> {
  await database.pool.query('SELECT 1');
  await assertDatabaseMigrated(database);
}
