import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../fixtures/fixtures.js';
import { materializePostgres, type PostgresMaterialization } from '../fixtures/materialize.js';
import {
  detectSourceVersion,
  formatInspectReport,
  inspectSource,
  openSource,
  SourceError,
  type SourceReader,
  type SourceRow,
} from '../src/index.js';
import { readmeCounts, readReadme } from './support/fixture-files.js';
import { hashFolder, materializeFolder, type MaterializedFolder } from './support/folders.js';

const readme = readmeCounts(readReadme());

describe.each(FIXTURES)('PGlite reader on $name', (fixture) => {
  let source: MaterializedFolder;

  beforeAll(async () => {
    source = await materializeFolder(fixture.name);
  });

  afterAll(async () => {
    await source.dispose();
  });

  it('detects the source version', async () => {
    const report = await inspectSource(source.folder);
    expect(report.version).toBe(fixture.name);
    expect(report.journal).toBe(fixture.migrations);
  });

  it('counts the rows the fixture README lists', async () => {
    const report = await inspectSource(source.folder);
    for (const [table, byFixture] of readme) {
      const expected = byFixture.get(fixture.name);
      expect(report.counts.get(table as never) ?? null).toBe(expected);
    }
  });

  it('leaves the original folder byte for byte unchanged and removes its working copy', async () => {
    const before = await hashFolder(source.folder);
    const workspace = await mkdtemp(join(source.scratch, 'tmp-'));
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = workspace;
    try {
      await inspectSource(source.folder);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(await hashFolder(source.folder)).toBe(before);
    expect(await readdir(workspace)).toEqual([]);
  });

  it('refuses writes', async () => {
    const reader = await openSource(source.folder);
    try {
      await expect(reader.query("update task set title = title where id = 'x'")).rejects.toThrow(
        /read-only/i,
      );
    } finally {
      await reader.close();
    }
  });

  it('prints the version and the counts', async () => {
    const text = formatInspectReport(await inspectSource(source.folder));
    expect(text).toContain(`source version: ${fixture.name}`);
    expect(text).toContain('task: 12');
  });
});

describe('PGlite folder refusals', () => {
  it('names an unknown PG_VERSION', async () => {
    const scratch = await materializeFolder('local-v2');
    try {
      await writeFile(join(scratch.folder, 'PG_VERSION'), '16\n');
      await expect(inspectSource(scratch.folder)).rejects.toThrow('PG_VERSION 16 is not supported');
    } finally {
      await scratch.dispose();
    }
  });

  it('refuses a folder without PG_VERSION', async () => {
    const scratch = await materializeFolder('local-v2');
    const empty = join(scratch.scratch, 'empty');
    await mkdir(empty);
    try {
      await expect(inspectSource(empty)).rejects.toThrow(/no PG_VERSION/);
    } finally {
      await scratch.dispose();
    }
  });

  it('refuses a role that row-level security hides rows from', async () => {
    const scratch = await materializeFolder('local-v2');
    const { PGlite } = await import('pglite-0-5-17');
    const database = new PGlite(scratch.folder);
    try {
      await database.exec('set role board_app');
      const reader: SourceReader = {
        kind: 'pglite',
        query: async (sql, params = []) => (await database.query<SourceRow>(sql, [...params])).rows,
        close: async () => undefined,
      };
      const error = await detectSourceVersion(reader).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SourceError);
      expect((error as Error).message).toMatch(/row-level security hides rows of .*task/);
    } finally {
      await database.close();
      await scratch.dispose();
    }
  });

  it('refuses an unknown schema version by its journal count', async () => {
    const scratch = await materializeFolder('local-v2');
    try {
      const reader = await openSource(scratch.folder);
      await reader.close();
      const { PGlite } = await import('pglite-0-5-17');
      const database = new PGlite(scratch.folder);
      await database.exec(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ('extra', 1)",
      );
      await database.close();
      const error = await inspectSource(scratch.folder).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SourceError);
      expect((error as Error).message).toContain('53 migrations in the journal');
    } finally {
      await scratch.dispose();
    }
  });
});

const postgresUrl = process.env.API_TEST_POSTGRES_URL ?? process.env.E2E_POSTGRES_URL;

describe.skipIf(postgresUrl === undefined)('Postgres reader', () => {
  let database: PostgresMaterialization;

  beforeAll(async () => {
    database = await materializePostgres(postgresUrl as string, 'hosted-main');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('detects hosted-main', async () => {
    const reader = await openSource(database.url);
    try {
      expect((await detectSourceVersion(reader)).version).toBe('hosted-main');
    } finally {
      await reader.close();
    }
  });

  it('fails a write attempt', async () => {
    const reader = await openSource(database.url);
    try {
      await expect(reader.query("update task set title = title where id = 'x'")).rejects.toThrow(
        /read-only/i,
      );
    } finally {
      await reader.close();
    }
  });

  it('refuses a role that row-level security applies to', async () => {
    const role = `migrate_reader_${randomBytes(4).toString('hex')}`;
    const admin = new pg.Client({ connectionString: postgresUrl });
    await admin.connect();
    try {
      await admin.query(`create role ${role} login password 'reader' in role board_app`);
      const url = new URL(database.url);
      url.username = role;
      url.password = 'reader';
      const reader = await openSource(url.toString());
      try {
        await expect(detectSourceVersion(reader)).rejects.toThrow(/row-level security hides rows/);
      } finally {
        await reader.close();
      }
    } finally {
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    }
  });
});

const ownerCopy = process.env.MIGRATE_OWNER_COPY;

describe.skipIf(ownerCopy === undefined)('copy of a real data folder', () => {
  it('opens and reports a supported version', async () => {
    const report = await inspectSource(ownerCopy as string);
    expect(report.counts.size).toBeGreaterThan(0);
  });
});
