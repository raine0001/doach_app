import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './',
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:5001',
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
});
