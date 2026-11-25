import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

export const NATIVE_ROOT = fileURLToPath(new URL('./src/native/list', import.meta.url));
export const NATIVE_BASE = '/_native/';

export default defineConfig({
  root: NATIVE_ROOT,
  base: NATIVE_BASE,
  build: {
    outDir: fileURLToPath(new URL('./dist/_native', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: { list: `${NATIVE_ROOT}/list.html` } },
  },
});
