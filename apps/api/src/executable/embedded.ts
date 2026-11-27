import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../cli.js';
import {
  embeddedPglite,
  openPgliteDatabase,
  useEmbeddedAssets,
  type PgliteFactory,
  type PgliteFiles,
} from '../modules/database/index.js';
import type { Env } from '../modules/index.js';

export interface EmbeddedFiles {
  pglite: PgliteFiles;
  migrations: Readonly<Record<string, string>>;
}

export const INITIALISE_PGLITE = '--initialise-pglite';

export const extractMigrations = async (
  files: EmbeddedFiles['migrations'],
  parent: string = tmpdir(),
): Promise<string> => {
  const folder = await mkdtemp(join(parent, 'rumo-api-migrations-'));
  await mkdir(join(folder, 'meta'));
  for (const [name, path] of Object.entries(files))
    await writeFile(join(folder, name), await readFile(path));
  return folder;
};

interface BunRuntime {
  gc(force: boolean): void;
}

// JavaScriptCore releases a WebAssembly memory only on the collection after the one that finds it unreachable.
const collectTwice = (bun: BunRuntime): void => {
  bun.gc(true);
  setTimeout(() => bun.gc(true), 0).unref();
};

const initialiseInChild = (dataDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INITIALISE_PGLITE, dataDir], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`initialising the PGlite data directory ended with ${signal ?? code}`));
    });
  });

// A first start runs initdb, whose memory peak (about 1 GiB) the process keeps as resident pages for
// its whole life even after collection, so a fresh data directory is initialised by a short-lived child.
export const initialisingFactory =
  (factory: PgliteFactory, initialise: (dataDir: string) => Promise<void>): PgliteFactory =>
  async (dataDir) => {
    if (!existsSync(join(dataDir, 'PG_VERSION'))) await initialise(dataDir);
    return factory(dataDir);
  };

export const runExecutable = async (
  files: EmbeddedFiles,
  args: readonly string[],
  env: Env,
): Promise<number> => {
  const factory = embeddedPglite(files.pglite);
  const [first, dataDir] = args;
  const migrations = await extractMigrations(files.migrations);
  try {
    if (first === INITIALISE_PGLITE && dataDir !== undefined) {
      useEmbeddedAssets({ pglite: factory, migrations });
      await (await openPgliteDatabase({ kind: 'pglite', dataDir })).close();
      return 0;
    }
    const bun = (globalThis as { Bun?: BunRuntime }).Bun;
    useEmbeddedAssets({
      pglite: initialisingFactory(factory, initialiseInChild),
      migrations,
      ...(bun === undefined ? {} : { collectGarbage: () => collectTwice(bun) }),
    });
    return await runCli(args, env);
  } finally {
    await rm(migrations, { recursive: true, force: true });
  }
};
