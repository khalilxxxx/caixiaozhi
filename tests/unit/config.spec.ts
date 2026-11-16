import { describe, expect, it } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';

const environment = {
  APP_MODE: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/caixiaozhi_test',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'caixiaozhi-private',
  S3_ACCESS_KEY_ID: 'local-test-key',
  S3_SECRET_ACCESS_KEY: 'local-test-secret',
};

describe('环境配置', () => {
  it('加载 test 模式且模型配置不是必需字段', () => {
    const config = loadConfig(environment);
    expect(config.appMode).toBe('test');
    expect(config.apiPort).toBe(3000);
    expect(config.businessTimezone).toBe('Asia/Shanghai');
  });

  it.each([
    { APP_MODE: 'preview' },
    { API_PORT: '0' },
    { S3_ENDPOINT: 'not-a-url' },
    { DATABASE_URL: 'https://example.test' },
    { BUSINESS_TIMEZONE: 'unknown-zone' },
    { S3_SECRET_ACCESS_KEY: '' },
  ])('拒绝非法配置 %j', (change) => {
    expect(() => loadConfig({ ...environment, ...change })).toThrow(
      '环境配置无效',
    );
  });

  it('缺失配置报错中不泄漏密钥值', () => {
    expect(() =>
      loadConfig({
        APP_MODE: 'production',
        S3_SECRET_ACCESS_KEY: 'secret-value',
      }),
    ).toThrow('环境配置无效');
    try {
      loadConfig({ ...environment, DATABASE_URL: 'password-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('password-secret');
    }
  });
});
