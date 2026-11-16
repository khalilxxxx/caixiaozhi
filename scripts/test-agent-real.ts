import { spawnSync } from 'node:child_process';
import { loadConfig } from '@caixiaozhi/platform/config';
import { readDshModelConfig } from '@caixiaozhi/agent-runtime';
loadConfig();
try {
  readDshModelConfig();
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'tests/integration/dsh-runtime.spec.ts',
      '-t',
      'dsh_real_tool_roundtrip',
    ],
    { stdio: 'inherit', env: { ...process.env, AGENT_REAL_TEST: '1' } },
  );
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    process.stdout.write(
      '继续执行八条正式API旅程；每条会通过受控重建建立独立基线，旧代审计保留。\n',
    );
    const journeys = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', 'tests/e2e/journeys.spec.ts'],
      { stdio: 'inherit', env: { ...process.env, AGENT_REAL_TEST: '1' } },
    );
    process.exitCode = journeys.status ?? 1;
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      event: 'agent.real.blocked',
      status: '未配置',
      message:
        error instanceof Error ? error.message : '真实模型验证无法开始。',
      required: [
        'DSH_API_KEY',
        'DSH_BASE_URL',
        'DSH_MODEL',
        'DSH_CONTEXT_WINDOW',
      ],
    }) + '\n',
  );
  process.exitCode = 2;
}
