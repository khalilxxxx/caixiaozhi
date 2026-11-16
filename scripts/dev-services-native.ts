import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  closeSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadConfig } from '@caixiaozhi/platform/config';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = loadConfig();
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    '此脚本仅启动本机已安装的macOS arm64技术服务，其他环境请使用infra/compose.yaml。',
  );
const pgDirectory = join(root, '.runtime/pg-data');
const pgCtl = join(
  root,
  '.runtime/tools/node_modules/@embedded-postgres/darwin-arm64/native/bin/pg_ctl',
);
const binary = '/tmp/caixiaozhi-t01-tools/rustfs';
const databaseUrl = new URL(config.databaseUrl);
if (!existsSync(pgCtl) || !existsSync(binary) || !existsSync(pgDirectory))
  throw new Error(
    '缺少本机原生服务工件，请按README使用Compose或准备原生PostgreSQL/RustFS。',
  );
if (
  spawnSync(pgCtl, ['-D', pgDirectory, 'status'], { stdio: 'ignore' })
    .status !== 0
) {
  const result = spawnSync(
    pgCtl,
    [
      '-D',
      pgDirectory,
      '-l',
      join(root, '.runtime/postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${databaseUrl.port || '5432'} -k /tmp`,
      'start',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0)
    throw new Error('PostgreSQL原生服务启动失败，请查看本机日志。');
}
const s3Url = new URL(config.s3.endpoint);
let available = false;
try {
  await fetch(s3Url, { signal: AbortSignal.timeout(1500) });
  available = true;
} catch {}
if (!available) {
  const directory = '/tmp/caixiaozhi-t01-tools';
  mkdirSync(join(directory, 'data'), { recursive: true });
  mkdirSync(join(directory, 'logs'), { recursive: true });
  const log = openSync(join(root, '.runtime/rustfs.log'), 'a', 0o600);
  const child = spawn(binary, ['server', join(directory, 'data')], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      RUSTFS_ACCESS_KEY: config.s3.accessKeyId,
      RUSTFS_SECRET_KEY: config.s3.secretAccessKey,
      RUSTFS_ADDRESS: `127.0.0.1:${s3Url.port || '9000'}`,
      RUSTFS_CONSOLE_ENABLE: 'false',
      RUSTFS_OBS_LOG_DIRECTORY: join(directory, 'logs'),
    },
  });
  child.unref();
  closeSync(log);
  writeFileSync(join(root, '.runtime/rustfs.pid'), String(child.pid));
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await fetch(s3Url, { signal: AbortSignal.timeout(500) });
      available = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!available) throw new Error('RustFS启动后尚未响应，请检查本机日志。');
}
console.log('本机PostgreSQL与S3服务已运行，应用配置由.env读取。');
