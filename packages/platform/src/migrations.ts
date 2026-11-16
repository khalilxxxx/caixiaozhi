import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseConnection } from './database.js';

const defaultDirectory = fileURLToPath(
  new URL('../../../infra/migrations/', import.meta.url),
);
const migrationLock = 1_349_159_017;

type Migration = { id: string; checksum: string; content: string };
type AppliedMigration = { id: string; checksum: string };

async function readMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d+_[A-Za-z0-9_-]+\.sql$/u.test(name))
    .sort();
  if (names.length === 0) throw new Error('没有可执行的数据库迁移。');
  return Promise.all(
    names.map(async (id) => {
      const content = await readFile(join(directory, id), 'utf8');
      return {
        id,
        content,
        checksum: createHash('sha256').update(content).digest('hex'),
      };
    }),
  );
}

function verifyAppliedMigrations(
  migrations: Migration[],
  applied: AppliedMigration[],
): void {
  const known = new Map(
    migrations.map((migration) => [migration.id, migration]),
  );
  for (const migration of applied) {
    const local = known.get(migration.id);
    if (!local) throw new Error(`当前工程缺少已应用的迁移 ${migration.id}。`);
    if (local.checksum !== migration.checksum)
      throw new Error(`迁移摘要不一致 ${migration.id}，请新增迁移文件。`);
  }
}

/** 事务级 advisory lock 保证多个进程不会同时执行同一批迁移。 */
export async function migrateDatabase(
  database: DatabaseConnection,
  directory = defaultDirectory,
): Promise<{ applied: string[] }> {
  const migrations = await readMigrations(directory);
  const connection = await database.pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLock]);
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = await connection.query<AppliedMigration>(
      'SELECT id, checksum FROM schema_migrations ORDER BY id',
    );
    verifyAppliedMigrations(migrations, existing.rows);
    const appliedIds = new Set(existing.rows.map((migration) => migration.id));
    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (appliedIds.has(migration.id)) continue;
      await connection.query(migration.content);
      await connection.query(
        'INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)',
        [migration.id, migration.checksum],
      );
      newlyApplied.push(migration.id);
    }
    await connection.query('COMMIT');
    return { applied: newlyApplied };
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}

export async function assertDatabaseMigrated(
  database: DatabaseConnection,
  directory = defaultDirectory,
): Promise<void> {
  const migrations = await readMigrations(directory);
  const table = await database.pool.query<{ name: string | null }>(
    "SELECT to_regclass('schema_migrations')::text AS name",
  );
  if (!table.rows[0]?.name)
    throw new Error('数据库尚未迁移，请执行 pnpm db:migrate。');
  const applied = await database.pool.query<AppliedMigration>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  verifyAppliedMigrations(migrations, applied.rows);
  const appliedIds = new Set(applied.rows.map((migration) => migration.id));
  if (migrations.some((migration) => !appliedIds.has(migration.id)))
    throw new Error('数据库存在未执行迁移，请执行 pnpm db:migrate。');
}
