import { describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import {
  HealthResponseSchema,
  ApiErrorResponseSchema,
} from '@caixiaozhi/contracts';

const available = async () => {};
const unavailable = async () => {
  throw new Error('internal password=private-secret');
};

describe('API 健康检查', () => {
  it('依赖未就绪时存活检查仍返回 alive', async () => {
    const app = createApp({
      database: unavailable,
      storage: unavailable,
      dataMode: 'demo',
    });
    try {
      const response = await app.inject('/api/v1/health/live');
      expect(response.statusCode).toBe(200);
      const result = HealthResponseSchema.parse(response.json());
      if (!('data' in result)) throw new Error('预期成功响应');
      expect(result.data.status).toBe('alive');
    } finally {
      await app.close();
    }
  });

  it('所有依赖已就绪时返回 ready', async () => {
    const app = createApp({
      database: available,
      storage: available,
      dataMode: 'demo',
    });
    try {
      const response = await app.inject('/api/v1/health/ready');
      expect(response.statusCode).toBe(200);
      const result = HealthResponseSchema.parse(response.json());
      if (!('data' in result)) throw new Error('预期成功响应');
      expect(result.data.dependencies).toEqual({
        database: 'ready',
        storage: 'ready',
      });
      expect(result.data.status).toBe('ready');
    } finally {
      await app.close();
    }
  });

  it('数据库未就绪返回脱敏的503并标记对应依赖', async () => {
    const app = createApp({
      database: unavailable,
      storage: available,
      dataMode: 'demo',
    });
    try {
      const response = await app.inject('/api/v1/health/ready');
      expect(response.statusCode).toBe(503);
      const result = ApiErrorResponseSchema.parse(response.json());
      expect(result.error.code).toBe('DEPENDENCY_UNAVAILABLE');
      expect(result.error.details).toEqual({
        database: 'unavailable',
        storage: 'ready',
      });
      expect(response.body).not.toContain('private-secret');
      expect(response.body).not.toContain('password');
    } finally {
      await app.close();
    }
  });

  it('依赖探测超时后返回503', async () => {
    const app = createApp({
      database: () => new Promise(() => {}),
      storage: available,
      dataMode: 'demo',
      dependencyTimeoutMs: 20,
    });
    try {
      const response = await app.inject('/api/v1/health/ready');
      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('业务文件与自报身份接口未开放', async () => {
    const app = createApp({
      database: available,
      storage: available,
      dataMode: 'demo',
    });
    try {
      for (const url of ['/api/v1/files', '/api/v1/auth/demo']) {
        const response = await app.inject({
          method: 'POST',
          url,
          payload: { user_id: 'admin' },
        });
        expect(response.statusCode).toBe(404);
        expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe(
          'NOT_FOUND',
        );
      }
    } finally {
      await app.close();
    }
  });
});
