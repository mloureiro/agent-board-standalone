import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializePglite } from '../../fixtures/materialize.js';

export interface MaterializedFolder {
  readonly folder: string;
  readonly scratch: string;
  dispose(): Promise<void>;
}

export async function materializeFolder(name: string): Promise<MaterializedFolder> {
  const scratch = await mkdtemp(join(tmpdir(), `migrate-test-${name}-`));
  const folder = join(scratch, 'data');
  const database = await materializePglite(name, folder);
  await database.close();
  return { folder, scratch, dispose: () => rm(scratch, { recursive: true, force: true }) };
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? listFiles(root, join(relative, entry.name))
        : Promise.resolve([join(relative, entry.name)]),
    ),
  );
  return nested.flat().sort();
}

export async function hashFolder(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of await listFiles(root)) {
    hash
      .update(file)
      .update('\0')
      .update(await readFile(join(root, file)))
      .update('\0');
  }
  return hash.digest('hex');
}
