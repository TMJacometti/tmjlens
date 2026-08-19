import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
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
  },
});
