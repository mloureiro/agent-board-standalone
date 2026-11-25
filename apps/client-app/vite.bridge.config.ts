import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist-bridge',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: 'src/bridge/install.ts',
      formats: ['iife'],
      name: 'agentBoardBridgeInstall',
      fileName: () => 'bridge.js',
    },
  },
});
