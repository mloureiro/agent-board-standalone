import { execFileSync } from 'node:child_process';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

export default defineConfig({
  plugins: [react()],
  define: { __WEB_COMMIT__: JSON.stringify(commit()) },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
    testTimeout: 15_000,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
