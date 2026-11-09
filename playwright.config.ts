import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env['CI'] ? 1 : 0,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4200',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['iPad (gen 7) landscape'] } },
  ],
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : { command: 'npm run web:start', url: 'http://localhost:4200', reuseExistingServer: true, timeout: 180_000 },
});
