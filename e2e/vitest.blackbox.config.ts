import path from 'node:path';

import { defineConfig } from 'vitest/config';

import { loadExpectedRed, skipsListed, wholeFiles } from './src/ratchet/expected.ts';

const REFUSAL_FILE = 'blackbox/matrix-refusal.test.ts';
const refusalRun = process.env.E2E_MATRIX_EXPECT === 'refusal';
const skippedFiles = skipsListed(process.env)
  ? wholeFiles(loadExpectedRed(path.join(import.meta.dirname, 'expected-red.json')), '').filter(
      (file) => file.startsWith('blackbox/'),
    )
  : [];

export default defineConfig({
  test: {
    include: refusalRun ? [REFUSAL_FILE] : ['blackbox/**/*.test.ts'],
    exclude: refusalRun ? [] : ['**/node_modules/**', REFUSAL_FILE, ...skippedFiles],
    setupFiles: ['./src/harness/listed.ts'],
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
