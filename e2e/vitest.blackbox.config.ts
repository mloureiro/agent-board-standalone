import { defineConfig } from 'vitest/config';

const REFUSAL_FILE = 'blackbox/matrix-refusal.test.ts';
const refusalRun = process.env.E2E_MATRIX_EXPECT === 'refusal';

export default defineConfig({
  test: {
    include: refusalRun ? [REFUSAL_FILE] : ['blackbox/**/*.test.ts'],
    exclude: refusalRun ? [] : ['**/node_modules/**', REFUSAL_FILE],
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
