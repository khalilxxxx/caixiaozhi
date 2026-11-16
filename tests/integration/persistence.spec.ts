import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  copyFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueOutbox, outboxEvents } from '@caixiaozhi/jobs/outbox';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import {
  findFile,
  registerFile,
  transitionFile,
} from '@caixiaozhi/platform/files';
import {
  assertDatabaseMigrated,
  migrateDatabase,
} from '@caixiaozhi/platform/migrations';

const databaseUrl = loadConfig().databaseUrl;
const database = createDatabase(databaseUrl);
const tenantId = `integration-${randomUUID()}`;
const payloadSchema = z.object({ file_id: z.string().min(1) }).strict();
async function copyMigrations(directory: string) {
  const source = new URL('../../infra/migrations/', import.meta.url);
  for (const name of await readdir(source)) {
    if (name.endsWith('.sql'))
      await copyFile(new URL(name, source), join(directory, name));
  }
}
const fileInput = () => ({
  tenantId,
  ownerId: 'integration-owner',
  objectKey: `temporary/${tenantId}/${randomUUID()}`,
  originalFilename: '测试材料.txt',
  mimeType: 'text/plain',
  expectedSizeBytes: 12,
  uploadExpiresAt: new Date(Date.now() + 600_000),
});

describe('真实 PostgreSQL 持久化基础', () => {
  beforeAll(async () => {
    await Promise.all([migrateDatabase(database), migrateDatabase(database)]);
  });

  afterAll(async () => {
    await database.db.execute(
      sql`delete from outbox_events where tenant_id = ${tenantId}`,
    );
    await database.db.execute(
      sql`delete from uploaded_files where tenant_id = ${tenantId}`,
    );
    await database.close();
  });

  it('数据库连接强制使用 UTC 时区', async () => {
    const result = await database.pool.query('SHOW timezone');
    expect(result.rows[0]).toEqual({ TimeZone: 'UTC' });
  });

  it('重复及并发迁移只应用一次，并校验已应用文件摘要', async () => {
    await migrateDatabase(database);
    await assertDatabaseMigrated(database);
    const directory = await mkdtemp(join(tmpdir(), 'caixiaozhi-migration-'));
    try {
      await copyMigrations(directory);
      const migration = await readFile(
        new URL('../../infra/migrations/0001_persistence.sql', import.meta.url),
        'utf8',
      );
      await writeFile(
        join(directory, '0001_persistence.sql'),
        `${migration}\n-- unexpected change\n`,
      );
      await expect(migrateDatabase(database, directory)).rejects.toThrow(
        '迁移摘要不一致',
      );
      await expect(assertDatabaseMigrated(database, directory)).rejects.toThrow(
        '迁移摘要不一致',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('迁移 SQL 失败时，DDL 和迁移账本一起回滚', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'caixiaozhi-migration-failure-'),
    );
    const tableName = `migration_probe_${randomUUID().replaceAll('-', '')}`;
    try {
      await copyMigrations(directory);
      const migration = await readFile(
        new URL('../../infra/migrations/0001_persistence.sql', import.meta.url),
        'utf8',
      );
      await writeFile(join(directory, '0001_persistence.sql'), migration);
      await writeFile(
        join(directory, '9999_failure.sql'),
        `CREATE TABLE ${tableName} (id text); SELECT * FROM deliberately_missing_table;`,
      );
      await expect(migrateDatabase(database, directory)).rejects.toThrow();
      const table = await database.pool.query(
        'SELECT to_regclass($1)::text AS name',
        [tableName],
      );
      expect(table.rows[0]).toEqual({ name: null });
      const ledger = await database.pool.query(
        'SELECT id FROM schema_migrations WHERE id = $1',
        ['9999_failure.sql'],
      );
      expect(ledger.rows).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('文件元数据与领域 outbox 在同一事务提交，独立连接仍可读取', async () => {
    const file = await database.db.transaction(async (transaction) => {
      const created = await registerFile(transaction, fileInput());
      await enqueueOutbox(
        transaction,
        {
          tenantId,
          eventType: 'file.registered',
          resourceType: 'file',
          resourceId: created.id,
          resourceVersion: created.version,
          payload: { file_id: created.id },
        },
        payloadSchema,
      );
      return created;
    });
    const reopened = createDatabase(databaseUrl);
    try {
      const persisted = await findFile(reopened.db, { tenantId, id: file.id });
      expect(persisted).toMatchObject({
        id: file.id,
        tenantId,
        ownerId: 'integration-owner',
        version: 1,
        status: 'registered',
      });
      expect(persisted?.createdAt).toBeInstanceOf(Date);
      expect(
        await findFile(reopened.db, { tenantId: 'other-tenant', id: file.id }),
      ).toBeNull();
      const events = await reopened.db.select().from(outboxEvents);
      expect(
        events.find((event) => event.resourceId === file.id),
      ).toMatchObject({
        tenantId,
        resourceVersion: 1,
        schemaVersion: 1,
        eventType: 'file.registered',
        payload: { file_id: file.id },
      });
    } finally {
      await reopened.close();
    }
  });

  it('领域 schema 拒绝无效 payload 时，文件与 outbox 一并回滚', async () => {
    const id = randomUUID();
    await expect(
      database.db.transaction(async (transaction) => {
        await registerFile(transaction, { ...fileInput(), id });
        await enqueueOutbox(
          transaction,
          {
            tenantId,
            eventType: 'file.registered',
            resourceType: 'file',
            resourceId: id,
            resourceVersion: 1,
            payload: { file_id: id, unexpected: true },
          },
          payloadSchema,
        );
      }),
    ).rejects.toThrow();
    expect(await findFile(database.db, { tenantId, id })).toBeNull();
    const result = await database.db.execute(
      sql`select count(*)::int as count from outbox_events where resource_id = ${id}`,
    );
    expect(result.rows[0]).toEqual({ count: 0 });
  });

  it('领域对象 schema 默认剥离未知字段时，outbox 仍严格拒绝并回滚', async () => {
    const id = randomUUID();
    const defaultObjectSchema = z.object({ file_id: z.string().min(1) });
    await expect(
      database.db.transaction(async (transaction) => {
        await registerFile(transaction, { ...fileInput(), id });
        await enqueueOutbox(
          transaction,
          {
            tenantId,
            eventType: 'file.registered',
            resourceType: 'file',
            resourceId: id,
            resourceVersion: 1,
            payload: { file_id: id, unexpected: true },
          },
          defaultObjectSchema,
        );
      }),
    ).rejects.toThrow(z.ZodError);
    expect(await findFile(database.db, { tenantId, id })).toBeNull();
    const result = await database.db.execute(
      sql`select count(*)::int as count from outbox_events where resource_id = ${id}`,
    );
    expect(result.rows[0]).toEqual({ count: 0 });
  });

  it('异常终止事务不会留下文件或 outbox', async () => {
    const id = randomUUID();
    await expect(
      database.db.transaction(async (transaction) => {
        await registerFile(transaction, { ...fileInput(), id });
        await enqueueOutbox(
          transaction,
          {
            tenantId,
            eventType: 'file.registered',
            resourceType: 'file',
            resourceId: id,
            resourceVersion: 1,
            payload: { file_id: id },
          },
          payloadSchema,
        );
        throw new Error('模拟提交前失败');
      }),
    ).rejects.toThrow('模拟提交前失败');
    expect(await findFile(database.db, { tenantId, id })).toBeNull();
    const result = await database.db.execute(
      sql`select count(*)::int as count from outbox_events where resource_id = ${id}`,
    );
    expect(result.rows[0]).toEqual({ count: 0 });
  });

  it('更新校验租户、期望版本和上传状态，保持文件版本单调递增', async () => {
    const file = await registerFile(database.db, fileInput());
    const uploaded = await transitionFile(database.db, {
      tenantId,
      id: file.id,
      expectedVersion: 1,
      status: 'uploaded',
      sha256: 'ab'.repeat(32),
      sizeBytes: 12,
      mimeType: 'text/plain',
    });
    expect(uploaded).toMatchObject({
      version: 2,
      status: 'uploaded',
      sha256: 'ab'.repeat(32),
      sizeBytes: 12,
    });
    await expect(
      transitionFile(database.db, {
        tenantId,
        id: file.id,
        expectedVersion: 1,
        status: 'validated',
      }),
    ).rejects.toThrow('文件版本或状态不匹配');
    await expect(
      transitionFile(database.db, {
        tenantId: 'other-tenant',
        id: file.id,
        expectedVersion: 2,
        status: 'validated',
      }),
    ).rejects.toThrow('文件版本或状态不匹配');
    const validated = await transitionFile(database.db, {
      tenantId,
      id: file.id,
      expectedVersion: 2,
      status: 'validated',
    });
    expect(validated).toMatchObject({ version: 3, status: 'validated' });
  });
});
