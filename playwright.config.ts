import { defineConfig } from '@playwright/test';
const port = process.env.CHOKETMON_TEST_PORT ?? '5173';
export default defineConfig({
  testDir: './tests/ui', testIgnore: '**/tmp-*', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: process.env.CHOKETMON_BASE_URL ?? `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1100 }, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  // Start `pnpm dev` in the terminal first; tests use that same visible server.
});
