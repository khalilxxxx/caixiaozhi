import { fileURLToPath } from 'node:url';
/** 源码与dist均位于workspace package的同一层级，避免pnpm --filter改变cwd。 */
export const WORKSPACE_ROOT = fileURLToPath(
  new URL('../../../', import.meta.url),
);
