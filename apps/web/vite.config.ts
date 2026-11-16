import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
  const env = loadEnv(mode, workspaceRoot, 'API_');

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target:
            env.API_PROXY_TARGET ||
            `http://127.0.0.1:${env.API_PORT || '3000'}`,
          changeOrigin: true,
        },
      },
    },
  };
});
