export function assertMaintenanceAllowed(
  appMode: 'demo' | 'test' | 'production',
): void {
  if (appMode === 'production')
    throw new Error('production 环境禁止执行 seed/reset。');
}
