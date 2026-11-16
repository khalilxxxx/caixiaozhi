import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '@caixiaozhi/platform/database';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createStorage } from '@caixiaozhi/platform/storage';
import { createIdentityService } from '../../packages/identity/src/index.js';
import { createFileService } from '../../packages/files/src/index.js';
import { DocumentService } from '../../packages/business-adapters/src/domain/documents.js';
import { AppError } from '@caixiaozhi/platform/errors';
const config = loadConfig(),
  database = createDatabase(config.databaseUrl),
  storage = createStorage(config.s3);
const tenantId = `files-${randomUUID()}`;
const identity = createIdentityService(database, {
  sessionSecret: 'files-test-session-secret-at-least-32-characters',
  appMode: 'demo',
  demoAccessEnabled: true,
});
const files = createFileService(database, storage, { identity });
const documents = new DocumentService(database, { identity });
identity.registerResourceResolver('travel', (ctx, ref) =>
  documents.metadata(ctx, ref),
);
files.registerParentAuthorizer('travel', async (ctx, ref, access) => {
  const document = await documents.get(ctx, 'travel', ref.id);
  if (access?.write) {
    await identity.assertResourceAccess(ctx, 'travel.write.own', ref);
    if (document.owner_id !== ctx.user_id)
      throw new AppError('FORBIDDEN', '只能修改本人单据材料。');
    if (!['draft', 'returned', 'withdrawn'].includes(document.state))
      throw new AppError('INVALID_STATE', '当前单据不可编辑材料。');
  }
});
const created: string[] = [];
const actor = async (id: string) =>
  identity.getActor(
    (
      await identity.loginDemo(id, undefined, {
        tenantId,
        environmentId: tenantId,
        generation: 1,
      })
    ).session_token,
  );
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const uploadText = async (bytes: Uint8Array, filename = '制度.md') => {
  const ctx = await actor('u-liu');
  const registered = await files.registerUpload(
    ctx,
    {
      filename,
      mime_type: 'text/markdown',
      size_bytes: bytes.byteLength,
      profile: 'policy-text-v1',
    },
    randomUUID(),
  );
  created.push(registered.file.id);
  const uploaded = await files.upload(ctx, registered.file.id, bytes, {
    uploadToken: registered.upload_target.headers['x-upload-token'],
    expectedVersion: registered.file.version,
  });
  return { ctx, registered, uploaded };
};
describe('共享私有文件真实S3校验', () => {
  beforeAll(async () => {
    await identity.seedDemoIdentity({
      tenantId,
      environmentId: tenantId,
      generation: 1,
    });
  });
  afterAll(async () => {
    for (const id of created) {
      const row = await database.pool.query(
        'SELECT object_key FROM uploaded_files WHERE tenant_id=$1 AND id=$2',
        [tenantId, id],
      );
      if (row.rows[0]) await storage.deleteObject(row.rows[0].object_key);
    }
    await database.pool.query(
      'DELETE FROM file_command_ledger WHERE tenant_id=$1',
      [tenantId],
    );
    await database.pool.query('DELETE FROM uploaded_files WHERE tenant_id=$1', [
      tenantId,
    ]);
    for (const table of [
      'travel_legs',
      'travel_requests',
      'business_command_ledger',
      'outbox_events',
    ])
      await database.pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [
        tenantId,
      ]);
    await database.pool.query(
      'DELETE FROM identity_environments WHERE tenant_id=$1',
      [tenantId],
    );
    storage.close();
    await database.close();
  });
  it('真实上传、独立读取与重复finalize保持持久状态', async () => {
    const bytes = Buffer.from('# 差旅制度\r\n住宿每间夜800元。😀\r\n');
    const { ctx, registered, uploaded } = await uploadText(bytes);
    const command = { expected_version: uploaded.version, sha256: sha(bytes) };
    const finalized = await files.finalizeUpload(
      ctx,
      registered.file.id,
      command,
      'finalize-same',
    );
    expect(finalized.status).toBe('validated');
    expect(
      await files.finalizeUpload(
        ctx,
        registered.file.id,
        command,
        'finalize-same',
      ),
    ).toEqual(finalized);
    expect(
      Buffer.from((await files.readFile(ctx, registered.file.id)).bytes),
    ).toEqual(bytes);
    expect(JSON.stringify(finalized)).not.toContain('temporary/');
    await expect(
      files.readFile(await actor('u-zhao'), registered.file.id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('伪文本、非法UTF8和NUL均拒绝完成校验', async () => {
    for (const bytes of [
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from('制度\0伪造'),
    ]) {
      const { ctx, registered, uploaded } = await uploadText(bytes);
      await expect(
        files.finalizeUpload(
          ctx,
          registered.file.id,
          { expected_version: uploaded.version, sha256: sha(bytes) },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await files.getFile(ctx, registered.file.id)).status).toBe(
        'rejected',
      );
    }
  });
  it('实际签名与内容解析校验PDF，损坏文件不进入OCR', async () => {
    const { PDFDocument } = createRequire(
      new URL('../../packages/files/package.json', import.meta.url),
    )('pdf-lib');
    const document = await PDFDocument.create();
    document.addPage();
    const bytes = await document.save();
    const ctx = await actor('u-li');
    const registered = await files.registerUpload(
      ctx,
      {
        filename: '合成测试.pdf',
        mime_type: 'application/pdf',
        size_bytes: bytes.byteLength,
        profile: 'invoice-v1',
      },
      randomUUID(),
    );
    created.push(registered.file.id);
    const uploaded = await files.upload(ctx, registered.file.id, bytes, {
      uploadToken: registered.upload_target.headers['x-upload-token'],
      expectedVersion: registered.file.version,
    });
    expect(
      (
        await files.finalizeUpload(
          ctx,
          registered.file.id,
          { expected_version: uploaded.version, sha256: sha(bytes) },
          randomUUID(),
        )
      ).status,
    ).toBe('validated');
    const bad = Buffer.from('%PDF-1.7\n损坏文件\n%%EOF');
    const invalid = await files.registerUpload(
      ctx,
      {
        filename: '损坏.pdf',
        mime_type: 'application/pdf',
        size_bytes: bad.length,
        profile: 'invoice-v1',
      },
      randomUUID(),
    );
    created.push(invalid.file.id);
    const invalidUploaded = await files.upload(ctx, invalid.file.id, bad, {
      uploadToken: invalid.upload_target.headers['x-upload-token'],
      expectedVersion: invalid.file.version,
    });
    await expect(
      files.finalizeUpload(
        ctx,
        invalid.file.id,
        { expected_version: invalidUploaded.version, sha256: sha(bad) },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
  it('大小、hash、上传令牌与有效期不能由客户端绕过', async () => {
    const ctx = await actor('u-liu'),
      bytes = Buffer.from('有效制度文本');
    const registered = await files.registerUpload(
      ctx,
      {
        filename: '制度.md',
        mime_type: 'text/markdown',
        size_bytes: bytes.length,
        profile: 'policy-text-v1',
      },
      randomUUID(),
    );
    created.push(registered.file.id);
    await expect(
      files.upload(ctx, registered.file.id, bytes, {
        uploadToken: 'forged',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      files.upload(ctx, registered.file.id, Buffer.from('短'), {
        uploadToken: registered.upload_target.headers['x-upload-token'],
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await database.pool.query(
      "UPDATE uploaded_files SET upload_expires_at=now()-interval '1 second' WHERE id=$1",
      [registered.file.id],
    );
    await expect(
      files.upload(ctx, registered.file.id, bytes, {
        uploadToken: registered.upload_target.headers['x-upload-token'],
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('并发相同版本上传只有一个写入者，S3字节与接受的hash一致；并发finalize同key复用结果', async () => {
    const ctx = await actor('u-liu');
    const content = [
      Buffer.from('制度甲：同长文件内容'),
      Buffer.from('制度乙：同长文件内容'),
    ];
    const registered = await files.registerUpload(
      ctx,
      {
        filename: '并发.md',
        mime_type: 'text/markdown',
        size_bytes: content[0]!.length,
        profile: 'policy-text-v1',
      },
      randomUUID(),
    );
    created.push(registered.file.id);
    const results = await Promise.allSettled(
      content.map((bytes) =>
        files.upload(ctx, registered.file.id, bytes, {
          uploadToken: registered.upload_target.headers['x-upload-token'],
          expectedVersion: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    const accepted = results[winner]!;
    if (accepted.status !== 'fulfilled') throw new Error('没有接受上传');
    const command = {
      expected_version: accepted.value.version,
      sha256: sha(content[winner]!),
    };
    const key = randomUUID();
    const [first, second] = await Promise.all([
      files.finalizeUpload(ctx, registered.file.id, command, key),
      files.finalizeUpload(ctx, registered.file.id, command, key),
    ]);
    expect(first).toEqual(second);
    expect(
      Buffer.from((await files.readFile(ctx, registered.file.id)).bytes),
    ).toEqual(content[winner]);
  });
  it('主管可以读取他人已提交单据，但不能据此登记或绑定自己的附件', async () => {
    const li = await actor('u-li'),
      manager = await actor('u-zhang');
    const parent = await documents.create(
      li,
      'travel',
      { title: '父对象权限反例' },
      randomUUID(),
    );
    await database.pool.query(
      "UPDATE travel_requests SET state='pending_manager',submitted_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, parent.id],
    );
    expect((await documents.get(manager, 'travel', parent.id)).state).toBe(
      'pending_manager',
    );
    const input = {
      filename: '主管不能添加.pdf',
      mime_type: 'application/pdf' as const,
      size_bytes: 100,
      profile: 'invoice-v1' as const,
    };
    const before = await database.pool.query(
      'SELECT count(*)::int AS count FROM uploaded_files WHERE tenant_id=$1',
      [tenantId],
    );
    await expect(
      files.registerUpload(
        manager,
        { ...input, parent_ref: parent.resource_ref },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int AS count FROM uploaded_files WHERE tenant_id=$1',
          [tenantId],
        )
      ).rows[0].count,
    ).toBe(before.rows[0].count);
    const unbound = await files.registerUpload(manager, input, randomUUID());
    created.push(unbound.file.id);
    await expect(
      files.bindParent(manager, unbound.file.id, parent.resource_ref),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      (await files.getFile(manager, unbound.file.id)).parent_ref,
    ).toBeNull();
  });
  it('父单据提交后保留读取权，上传、finalize与重绑均重新检查写权限', async () => {
    const li = await actor('u-li'),
      manager = await actor('u-zhang');
    const parent = await documents.create(
      li,
      'travel',
      { title: '提交后锁定材料' },
      randomUUID(),
    );
    const { PDFDocument } = createRequire(
      new URL('../../packages/files/package.json', import.meta.url),
    )('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes: Uint8Array = await pdf.save();
    const registered = await files.registerUpload(
      li,
      {
        filename: '提交前材料.pdf',
        mime_type: 'application/pdf',
        size_bytes: bytes.byteLength,
        profile: 'invoice-v1',
        parent_ref: parent.resource_ref,
      },
      randomUUID(),
    );
    created.push(registered.file.id);
    const uploaded = await files.upload(li, registered.file.id, bytes, {
      uploadToken: registered.upload_target.headers['x-upload-token'],
      expectedVersion: registered.file.version,
    });
    await database.pool.query(
      "UPDATE travel_requests SET state='pending_manager',submitted_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, parent.id],
    );
    expect((await files.getFile(manager, registered.file.id)).status).toBe(
      'uploaded',
    );
    await expect(
      files.upload(li, registered.file.id, bytes, {
        uploadToken: registered.upload_target.headers['x-upload-token'],
        expectedVersion: uploaded.version,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      files.finalizeUpload(
        li,
        registered.file.id,
        { expected_version: uploaded.version, sha256: sha(bytes) },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      files.bindParent(li, registered.file.id, parent.resource_ref),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await files.getFile(li, registered.file.id)).status).toBe(
      'uploaded',
    );
  });
});
