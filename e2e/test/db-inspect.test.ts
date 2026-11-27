import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  flattenStrings,
  inspectDatabase,
  markerBytes,
  quoteIdentifier,
  scanBytes,
} from '../src/fixtures/db-inspect.js';
import { createPgliteDatabase, createPostgresDatabase } from '../src/harness/database.js';
import { createTmp } from '../src/harness/tmp.js';

const MARKER = 'needle-Ünï-7';
let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rumo-e2e-scan-'));
  mkdirSync(path.join(root, 'with', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'without'), { recursive: true });
  const bytes = markerBytes(MARKER);
  writeFileSync(
    path.join(root, 'with', 'utf8.bin'),
    Buffer.concat([Buffer.from('xx'), bytes['utf-8']]),
  );
  writeFileSync(
    path.join(root, 'with', 'nested', 'le.bin'),
    Buffer.concat([Buffer.from('y'), bytes['utf-16le']]),
  );
  writeFileSync(
    path.join(root, 'with', 'be.bin'),
    Buffer.concat([Buffer.from('zzz'), bytes['utf-16be']]),
  );
  writeFileSync(path.join(root, 'without', 'a.bin'), 'nothing to see here');
  writeFileSync(path.join(root, 'without', 'b.bin'), Buffer.from('needle', 'utf16le'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanBytes', () => {
  it('finds a marker in UTF-8, UTF-16LE and UTF-16BE', async () => {
    const hits = await scanBytes(path.join(root, 'with'), MARKER);
    const byName = Object.fromEntries(
      hits.map((hit) => [path.basename(hit.file), [...hit.encodings]]),
    );
    expect(byName).toEqual({
      'utf8.bin': ['utf-8'],
      'le.bin': ['utf-16le'],
      'be.bin': ['utf-16be'],
    });
  });

  it('finds nothing in a folder without the marker', async () => {
    expect(await scanBytes(path.join(root, 'without'), MARKER)).toEqual([]);
  });

  it('refuses an empty marker', async () => {
    await expect(scanBytes(root, '')).rejects.toThrow(/empty/);
  });
});

describe('helpers', () => {
  it('quotes identifiers', () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it('flattens every string in nested values, keys included', () => {
    expect(flattenStrings({ a: ['x', { b: 'y' }], c: 3, d: null })).toEqual([
      'a',
      'x',
      'b',
      'y',
      'c',
      'd',
    ]);
  });
});

describe('inspectDatabase', () => {
  it('refuses a PGlite database', async () => {
    const tmp = createTmp('db-inspect');
    try {
      await expect(inspectDatabase(createPgliteDatabase(tmp))).rejects.toThrow(/Postgres/);
    } finally {
      tmp.remove();
    }
  });

  it.skipIf(!process.env.E2E_POSTGRES_URL)(
    'dumps every text, jsonb and array column with its values',
    async () => {
      const tmp = createTmp('db-inspect');
      const database = await createPostgresDatabase(tmp);
      try {
        const client = new pg.Client({ connectionString: database.adminUrl as string });
        await client.connect();
        await client.query(
          `create table notes ("weird""name" text, doc jsonb, tags text[], n integer, id uuid)`,
        );
        await client.query(
          `insert into notes values ('plain', '{"k":"v"}', array['t1','t2'], 4, gen_random_uuid())`,
        );
        await client.end();
        const inspector = await inspectDatabase(database);
        const dumps = await inspector.columns();
        expect(dumps.map((dump) => dump.column).sort()).toEqual(['doc', 'tags', 'weird"name']);
        const strings = (await inspector.strings()).map((entry) => entry.value);
        expect(strings).toEqual(expect.arrayContaining(['plain', 'k', 'v', 't1', 't2']));
        expect(await inspector.count('notes')).toBe(1);
        expect(await inspector.tables()).toContain('notes');
        await inspector.close();
      } finally {
        await database.drop();
        tmp.remove();
      }
    },
  );
});
