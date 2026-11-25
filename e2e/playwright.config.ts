import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const reportFile = process.env.E2E_REPORT;

export default defineConfig({
  testDir: 'browser',
  retries: 0,
  fullyParallel: false,
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'agent-board-e2e-results'),
  reporter: reportFile ? [['json', { outputFile: reportFile }], ['list']] : [['list']],
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@webkit/ },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] }, grepInvert: /@chromium/ },
    {
      name: 'chromium-phone',
      use: { ...devices['Pixel 7'] },
      grep: /@phone/,
      grepInvert: /@webkit/,
    },
    {
      name: 'webkit-phone',
      use: { ...devices['iPhone 14'] },
      grep: /@phone/,
      grepInvert: /@chromium/,
    },
  ],
});
