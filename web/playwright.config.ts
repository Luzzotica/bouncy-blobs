import { defineConfig, devices } from '@playwright/test';

/**
 * Two profiles share this config:
 *  - smoke   → npm run test:e2e   (CI: headless, short, asserts no console errors)
 *  - record  → npm run record:match (headed, longer, saves mp4 + screenshot)
 *
 * Both spin up the Vite dev server via `webServer`. Override the API key with
 * VITE_MP_API_KEY in the calling shell so any party-API requests work.
 */
export default defineConfig({
  testDir: './playwright',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    video: {
      mode: 'on',
      size: { width: 1280, height: 720 },
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
