import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

import { NATIVE_PAGES, nativePageConfig } from './native.js';

const PART_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AssembleOptions {
  readonly webDist: string;
  readonly outDir: string;
}

export const defaultOptions: AssembleOptions = {
  webDist: path.join(PART_ROOT, '../web/dist'),
  outDir: path.join(PART_ROOT, 'dist'),
};

async function requireWebBuild(webDist: string): Promise<void> {
  try {
    await readFile(path.join(webDist, 'version.json'));
  } catch {
    throw new Error(
      `${webDist}/version.json is missing: run \`pnpm --filter @rumo/web build\` first`,
    );
  }
}

export async function assembleFrontend(options: AssembleOptions = defaultOptions): Promise<void> {
  await requireWebBuild(options.webDist);
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  await cp(options.webDist, options.outDir, { recursive: true });
  const nativeDir = path.join(options.outDir, '_native');
  for (const [index, page] of NATIVE_PAGES.entries()) {
    await build(nativePageConfig(page, nativeDir, index === 0));
  }
}

export async function buildBridgeScript(): Promise<void> {
  await build({ configFile: path.join(PART_ROOT, 'vite.bridge.config.ts'), logLevel: 'warn' });
}
