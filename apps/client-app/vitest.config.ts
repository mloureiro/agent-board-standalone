import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    testTimeout: 30_000,
    include: ['test/**/*.test.ts'],
  },
});
