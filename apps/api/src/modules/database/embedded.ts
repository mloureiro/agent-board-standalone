import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';

import type { PgliteFactory } from './pglite.js';

export interface EmbeddedAssets {
  pglite?: PgliteFactory;
  migrations?: string;
}

let assets: EmbeddedAssets = {};

export const useEmbeddedAssets = (next: EmbeddedAssets): void => {
  assets = next;
};

export const embeddedAssets = (): EmbeddedAssets => assets;

export interface PgliteFiles {
  wasm: string;
  initdb: string;
  data: string;
}

const bytes = async (path: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await readFile(path));

export const embeddedPglite =
  (files: PgliteFiles): PgliteFactory =>
  async (dataDir) =>
    PGlite.create({
      dataDir,
      pgliteWasmModule: await WebAssembly.compile(await bytes(files.wasm)),
      initdbWasmModule: await WebAssembly.compile(await bytes(files.initdb)),
      fsBundle: new Blob([await bytes(files.data)]),
    });
