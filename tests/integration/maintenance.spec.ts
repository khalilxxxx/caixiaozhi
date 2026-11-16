import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertMaintenanceAllowed } from '@caixiaozhi/platform/maintenance';

describe('数据库维护入口', () => {
  it('demo/test 允许初始化，production 明确拒绝', () => {
    expect(() => assertMaintenanceAllowed('demo')).not.toThrow();
    expect(() => assertMaintenanceAllowed('test')).not.toThrow();
    expect(() => assertMaintenanceAllowed('production')).toThrow(
      'production 环境禁止执行 seed/reset',
    );
  });

  it.each(['seed', 'reset'])(
    'production 的 db:%s 脚本在连接数据库前拒绝',
    (operation) => {
      const result = spawnSync(
        process.execPath,
        [
          '--conditions=development',
          '--import=tsx',
          `scripts/db-${operation}.ts`,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            APP_MODE: 'production',
            DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
            S3_ENDPOINT: 'http://127.0.0.1:1',
            S3_BUCKET: 'unused-private',
            S3_ACCESS_KEY_ID: 'unused-access-key',
            S3_SECRET_ACCESS_KEY: 'unused-secret-key',
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('production 环境禁止执行 seed/reset');
      expect(result.stderr).not.toContain('ECONNREFUSED');
    },
  );
});
