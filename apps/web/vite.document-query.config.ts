import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5186,
    strictPort: true,
    open: '/document-query.html',
  },
  build: {
    outDir: 'dist-document-query',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./document-query.html', import.meta.url)),
    },
  },
});
