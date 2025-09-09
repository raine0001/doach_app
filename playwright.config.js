// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',                   // where your spec lives
  testMatch: /(shot_flow|release_core)\.spec\.(ts|js)/,  // core + main spec
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:5001',
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python app.py',             // or 'py app.py' if that's your launcher
    port: 5001,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },  // keep it to one browser for speed
  ],
});
