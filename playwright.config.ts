import { defineConfig } from '@playwright/test';
const port = process.env.CHOKETMON_TEST_PORT ?? '5174';
export default defineConfig({
  testDir: './tests/ui', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1100 }, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `npm run dev -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI, timeout: 30000 }
});
