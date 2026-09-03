import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4317,
    strictPort: false,
  },
  preview: {
    port: 4318,
    strictPort: false,
  },
  worker: {
    format: 'es',
  },
});
