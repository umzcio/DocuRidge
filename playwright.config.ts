import { defineConfig, devices } from '@playwright/test';

// baseURL has a trailing slash so relative paths in tests resolve under /DocuRidge.
// e.g. page.goto('login') → http://127.0.0.1:3737/DocuRidge/login
const rawBase = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3737/DocuRidge';
const baseURL = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'smoke',
      testDir: './tests/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
