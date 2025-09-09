// playwright.config.ts
import { defineConfig } from '@playwright/test';

const camFile = process.env.DOACH_FAKE_CAM || '';
const camArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  ...(camFile ? [`--use-file-for-fake-video-capture=${camFile}`] : [])
];

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  outputDir: 'test-results',                // ensure this exists / is creatable
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5001',       // <-- set to your app URL/port
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['camera', 'microphone'],
  },

  // only run our single spec by default
  testMatch: /(shot_flow|release_core|live_cam)\.spec\.ts/,

  webServer: {
    command: 'python app.py', // or 'py app.py'
    port: 5001,
    reuseExistingServer: true,
    timeout: 60_000,
  },

  // keep just chrome for now to speed up the loop
  projects: [
    { name: 'chrome', use: { channel: 'chrome', launchOptions: { args: camArgs } } },
    // comment these for now:
    // { name: 'chromium', use: { browserName: 'chromium' } },
    // { name: 'firefox',  use: { browserName: 'firefox' } },
    // { name: 'webkit',   use: { browserName: 'webkit' } },
  ],
});
