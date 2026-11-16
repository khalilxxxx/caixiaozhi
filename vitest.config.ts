import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 20000,
    fileParallelism: false,
    include: ['tests/**/*.spec.ts'],
  },
});
