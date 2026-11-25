import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

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
      `${webDist}/version.json is missing: run \`pnpm --filter @agent-board/web build\` first`,
    );
  }
}

export async function assembleFrontend(options: AssembleOptions = defaultOptions): Promise<void> {
  await requireWebBuild(options.webDist);
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  await cp(options.webDist, options.outDir, { recursive: true });
  await build({
    configFile: path.join(PART_ROOT, 'vite.native.config.ts'),
    logLevel: 'warn',
    build: { outDir: path.join(options.outDir, '_native'), emptyOutDir: true },
  });
}

export async function buildBridgeScript(): Promise<void> {
  await build({ configFile: path.join(PART_ROOT, 'vite.bridge.config.ts'), logLevel: 'warn' });
}
