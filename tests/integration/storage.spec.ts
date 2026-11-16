import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createStorage } from '@caixiaozhi/platform/storage';

const config = loadConfig();
const storage = createStorage(config.s3);
const key = `integration/${randomUUID()}/测试材料.txt`;

afterAll(async () => {
  await storage.deleteObject(key);
  storage.close();
});

describe('真实私有 S3 对象存储', () => {
  it('实际写入、重新创建客户端读取并删除，匿名无法读取同一对象', async () => {
    await storage.checkReady();
    const body = new TextEncoder().encode('财小智私有文件集成测试');
    await storage.putObject({
      key,
      body,
      contentType: 'text/plain; charset=utf-8',
    });
    const reopened = createStorage(config.s3);
    try {
      const object = await reopened.getObject(key);
      expect(object.body).toEqual(body);
      expect(object.contentType).toContain('text/plain');
      const anonymousUrl = `${config.s3.endpoint.replace(/\/$/, '')}/${encodeURIComponent(config.s3.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
      const response = await fetch(anonymousUrl);
      expect([401, 403]).toContain(response.status);
    } finally {
      reopened.close();
    }
    await storage.deleteObject(key);
    await expect(storage.getObject(key)).rejects.toThrow();
  });
});
