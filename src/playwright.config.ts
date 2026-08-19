import { defineConfig } from '@playwright/test';

const PORT = 5210;

export default defineConfig({
  // Specs live inside the npm package so `@playwright/test` resolves from them.
  testDir: './tests',
  fullyParallel: true,
  // One Vite dev server serves every worker, and it transforms modules on first hit.
  // Past four browsers the first navigation of a run starts timing out, so a test fails
  // in setup rather than for anything it asserts. Capped rather than left to the CPU
  // count, which on a large machine makes the suite intermittently red.
  workers: 4,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Drives the system's installed Edge instead of Playwright's bundled Chromium,
    // so `npm run test:e2e` needs no browser download. To use bundled Chromium
    // instead (CI, or a machine without Edge), drop this line and run
    // `npx playwright install chromium`.
    channel: 'msedge',
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/preview.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
