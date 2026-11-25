import { defineConfig, devices } from '@playwright/test';

const PORT = 4181;

export default defineConfig({
  testDir: 'phone',
  testMatch: /.*\.spec\.ts/,
  retries: 0,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `node phone/serve.ts`,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium-phone', use: { ...devices['Pixel 7'] } },
    { name: 'chromium-small-phone', use: { ...devices['Galaxy S9+'] } },
  ],
});
