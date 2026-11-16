import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5190, strictPort: true,
    proxy: { '/api/local': { target: 'http://127.0.0.1:5191', changeOrigin: true, timeout: 240000 } },
  },
  build: {
    outDir: 'dist-agent',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./agent.html', import.meta.url)),
    },
  },
});
