import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/pdf-preparation', testMatch: '*.spec.ts', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4179', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config tests/pdf-preparation/vite.config.ts', url: 'http://127.0.0.1:4179', reuseExistingServer: !process.env.CI },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }, { name: 'mobile', use: { ...devices['Pixel 7'] } }],
});
