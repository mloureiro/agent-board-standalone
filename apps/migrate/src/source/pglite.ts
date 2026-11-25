import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALIASES_BY_PG_MAJOR,
  PGLITE_CONSTRUCTORS,
  type PgliteAlias,
  type PgliteInstance,
} from './pglite-builds.js';
import { SourceError, type SourceReader, type SourceRow } from './reader.js';

export async function readPgMajor(folder: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(join(folder, 'PG_VERSION'), 'utf8');
  } catch {
    throw new SourceError(`"${folder}" is not a PGlite data folder: it has no PG_VERSION file`);
  }
  return text.trim();
}

export const aliasesFor = (major: string): readonly PgliteAlias[] => {
  const aliases = ALIASES_BY_PG_MAJOR[major];
  if (aliases === undefined) {
    const known = Object.keys(ALIASES_BY_PG_MAJOR).join(', ');
    throw new SourceError(`PG_VERSION ${major} is not supported (supported: ${known})`);
  }
  return aliases;
};

async function openCopy(
  folder: string,
  alias: PgliteAlias,
): Promise<{ database: PgliteInstance; scratch: string }> {
  const scratch = await mkdtemp(join(tmpdir(), 'agent-board-migrate-'));
  const copy = join(scratch, 'data');
  try {
    await cp(folder, copy, { recursive: true });
    const database = new PGLITE_CONSTRUCTORS[alias](copy);
    await database.waitReady;
    return { database, scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

export async function openPgliteFolder(folder: string): Promise<SourceReader> {
  const aliases = aliasesFor(await readPgMajor(folder));
  const failures: string[] = [];
  for (const alias of aliases) {
    let opened: Awaited<ReturnType<typeof openCopy>>;
    try {
      opened = await openCopy(folder, alias);
    } catch (error) {
      failures.push(`${alias}: ${(error as Error).message}`);
      continue;
    }
    const { database, scratch } = opened;
    try {
      await database.exec('begin transaction read only');
    } catch (error) {
      await database.close().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
    return {
      kind: 'pglite',
      async query(sql, params = []): Promise<SourceRow[]> {
        return (await database.query<SourceRow>(sql, [...params])).rows;
      },
      async close() {
        await database.close().catch(() => undefined);
        await rm(scratch, { recursive: true, force: true });
      },
    };
  }
  throw new SourceError(`no PGlite build opens "${folder}" (${failures.join('; ')})`);
}
