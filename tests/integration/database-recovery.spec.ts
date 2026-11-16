import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';

const config = loadConfig();

const childSource = `
import { loadConfig } from '@caixiaozhi/platform/config';
import { createDatabase } from '@caixiaozhi/platform/database';
const database = createDatabase(loadConfig().databaseUrl);
const continueProbe = new Promise((resolve) => process.stdin.once('data', resolve));
try {
  const result = await database.pool.query('SELECT pg_backend_pid() AS pid');
  console.log(JSON.stringify({ event: 'idle', pid: result.rows[0].pid }));
  await continueProbe;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const recovered = await database.pool.query('SELECT 1 AS value');
  console.log(JSON.stringify({ event: 'recovered', value: recovered.rows[0].value }));
} finally {
  process.stdin.pause();
  await database.close();
}
`;

describe('真实 PostgreSQL 连接故障恢复', () => {
  it('慢查询在三秒内被数据库取消，后续查询仍可使用连接池', async () => {
    const database = createDatabase(config.databaseUrl);
    try {
      const startedAt = performance.now();
      await expect(
        database.pool.query('SELECT pg_sleep(10)'),
      ).rejects.toMatchObject({ code: '57014' });
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      const recovered = await database.pool.query('SELECT 1 AS value');
      expect(recovered.rows[0]).toEqual({ value: 1 });
    } finally {
      await database.close();
    }
  });

  it('服务器终止空闲连接后进程存活，日志脱敏且下一次查询重新连接', async () => {
    const administrator = createDatabase(config.databaseUrl);
    const child = spawn(
      process.execPath,
      [
        '--conditions=development',
        '--import=tsx',
        '--input-type=module',
        '-e',
        childSource,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.on('error', () => {});
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const lines = createInterface({ input: child.stdout });
    const idlePid = new Promise<number>((resolve, reject) => {
      lines.on('line', (line) => {
        const event = JSON.parse(line) as { event: string; pid?: number };
        if (event.event === 'idle' && event.pid) resolve(event.pid);
      });
      child.once('close', () =>
        reject(new Error('子进程未建立空闲数据库连接。')),
      );
      child.once('error', reject);
    });
    try {
      const pid = await idlePid;
      const terminated = await administrator.pool.query(
        'SELECT pg_terminate_backend($1) AS terminated',
        [pid],
      );
      expect(terminated.rows[0]).toEqual({ terminated: true });
      child.stdin.end('继续查询\n');
      expect(await completed).toBe(0);
      expect(stdout).toContain('"event":"recovered","value":1');
      expect(stderr).toContain('"event":"database.idle_connection_error"');
      expect(stderr).not.toContain(config.databaseUrl);
      const password = decodeURIComponent(new URL(config.databaseUrl).password);
      if (password) expect(stderr).not.toContain(password);
    } finally {
      lines.close();
      if (child.exitCode === null) child.kill('SIGTERM');
      await completed;
      await administrator.close();
    }
  });
});
