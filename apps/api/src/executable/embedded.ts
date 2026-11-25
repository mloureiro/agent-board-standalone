import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli } from '../cli.js';
import { embeddedPglite, useEmbeddedAssets, type PgliteFiles } from '../modules/database/index.js';
import type { Env } from '../modules/index.js';

export interface EmbeddedFiles {
  pglite: PgliteFiles;
  migrations: Readonly<Record<string, string>>;
}

export const extractMigrations = async (
  files: EmbeddedFiles['migrations'],
  parent: string = tmpdir(),
): Promise<string> => {
  const folder = await mkdtemp(join(parent, 'agent-board-api-migrations-'));
  await mkdir(join(folder, 'meta'));
  for (const [name, path] of Object.entries(files))
    await writeFile(join(folder, name), await readFile(path));
  return folder;
};

export const runExecutable = async (
  files: EmbeddedFiles,
  args: readonly string[],
  env: Env,
): Promise<number> => {
  const migrations = await extractMigrations(files.migrations);
  useEmbeddedAssets({ pglite: embeddedPglite(files.pglite), migrations });
  try {
    return await runCli(args, env);
  } finally {
    await rm(migrations, { recursive: true, force: true });
  }
};
