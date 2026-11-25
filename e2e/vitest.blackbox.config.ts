import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['blackbox/**/*.test.ts'],
    fileParallelism: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
