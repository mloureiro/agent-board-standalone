import os from 'node:os';
import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import {
  loadExpectedRed,
  playwrightGrepInvert,
  skipsListed,
  wholeFiles,
} from './src/ratchet/expected.ts';

const reportFile = process.env.E2E_REPORT;
const PREFIX = 'browser/';
const expected = skipsListed(process.env)
  ? loadExpectedRed(path.join(import.meta.dirname, 'expected-red.json'))
  : null;

function invert(project: string, own: RegExp): RegExp[] {
  return expected === null ? [own] : [own, ...playwrightGrepInvert(expected, PREFIX, project)];
}

export default defineConfig({
  testDir: 'browser',
  testIgnore:
    expected === null ? [] : wholeFiles(expected, PREFIX).map((file) => `**/${PREFIX}${file}`),
  retries: 0,
  fullyParallel: false,
  outputDir: process.env.E2E_OUTPUT_DIR ?? path.join(os.tmpdir(), 'agent-board-e2e-results'),
  reporter: reportFile ? [['json', { outputFile: reportFile }], ['list']] : [['list']],
  use: { screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'] },
      grepInvert: invert('chromium-desktop', /@webkit|@phone-only/),
    },
    {
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'] },
      grepInvert: invert('webkit-desktop', /@chromium|@phone-only/),
    },
    {
      name: 'chromium-phone',
      use: { ...devices['Pixel 7'] },
      grep: /@phone/,
      grepInvert: invert('chromium-phone', /@webkit/),
    },
    {
      name: 'webkit-phone',
      use: { ...devices['iPhone 14'] },
      grep: /@phone/,
      grepInvert: invert('webkit-phone', /@chromium/),
    },
  ],
});
