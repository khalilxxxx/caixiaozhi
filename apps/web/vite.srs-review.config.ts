import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5187,
    strictPort: true,
    open: '/srs-review.html',
  },
  build: {
    outDir: 'dist-srs-review',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./srs-review.html', import.meta.url)),
    },
  },
});
