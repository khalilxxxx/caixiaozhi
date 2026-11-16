import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    // Vite页面可先于API启动；必须等真实依赖就绪，避免首个同源代理请求收到500。
    url: 'http://127.0.0.1:3000/api/v1/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
