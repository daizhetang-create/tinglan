import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { include: ['@huggingface/transformers'] },
  server: {
    port: 4317,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.TINGLAN_BRIDGE_PORT || 4319}`, changeOrigin: true } },
  },
  preview: {
    port: 4318,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4319', changeOrigin: true } },
  },
  worker: {
    format: 'es',
  },
});
