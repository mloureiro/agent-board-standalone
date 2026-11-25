import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InlineConfig } from 'vite';

export const NATIVE_PAGES = ['list', 'tabbar'] as const;
export const NATIVE_BASE = '/_native/';

const NATIVE_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/native');

export function nativePageConfig(
  page: (typeof NATIVE_PAGES)[number],
  outDir: string,
  emptyOutDir: boolean,
): InlineConfig {
  const root = `${NATIVE_SOURCE}/${page}`;
  return {
    configFile: false,
    root,
    base: NATIVE_BASE,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir,
      sourcemap: false,
      rollupOptions: { input: { [page]: `${root}/${page}.html` } },
    },
  };
}
