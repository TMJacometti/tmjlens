import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // See src/lib/unused-module.ts — jsPDF's raster paths are never taken.
      html2canvas: fileURLToPath(new URL('./lib/unused-module.ts', import.meta.url)),
      canvg: fileURLToPath(new URL('./lib/unused-module.ts', import.meta.url)),
      dompurify: fileURLToPath(new URL('./lib/unused-module.ts', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Web dev: the axum server owns /api and /auth; Vite owns hot reload.
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
    },
  },
  test: {
    // Two runners share this tree, so the suffix decides which owns a file:
    // `.test.ts` is a Vitest unit test, `.spec.ts` is a Playwright end-to-end test.
    // Without this, Vitest collects the Playwright specs and fails on their hooks.
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'tests/**'],
  },
});
