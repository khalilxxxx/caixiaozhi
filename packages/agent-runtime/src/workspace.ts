import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { AppError } from '@caixiaozhi/platform/errors';

const segment = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export async function createWorkspace(
  root: string,
  scope: {
    tenant_id: string;
    owner_id: string;
    run_id: string;
    lease_epoch: number;
  },
) {
  const base = resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink())
    throw new AppError('DEPENDENCY_UNAVAILABLE', '运行目录配置无效。');
  const path = join(
    base,
    segment(scope.tenant_id),
    segment(scope.owner_id),
    segment(scope.run_id),
    String(scope.lease_epoch),
  );
  // 所有目录标识由服务端散列；每轮 epoch 使用新 home，不强抢旧 JSONL 所有权。
  let cursor = base;
  for (const part of path.slice(base.length + 1).split(sep)) {
    cursor = join(cursor, part);
    await mkdir(cursor, { mode: 0o700 }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new AppError('DEPENDENCY_UNAVAILABLE', '运行目录隔离检查失败。');
  }
  const real = await realpath(path);
  if (!real.startsWith((await realpath(base)) + sep))
    throw new AppError('FORBIDDEN', '运行目录不可访问。');
  return {
    path,
    home: join(path, 'home'),
    session_store_ref: `${segment(scope.tenant_id)}:${segment(scope.owner_id)}:${segment(scope.run_id)}:${scope.lease_epoch}`,
  };
}

export function assertWorkspaceScope(
  actual: { tenant_id: string; owner_id: string },
  expected: { tenant_id: string; owner_id: string },
) {
  if (
    actual.tenant_id !== expected.tenant_id ||
    actual.owner_id !== expected.owner_id
  )
    throw new AppError('NOT_FOUND', '运行空间不存在。');
}
