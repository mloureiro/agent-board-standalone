import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

import type { Database } from '../harness/database.js';

export interface ColumnDump {
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly values: readonly unknown[];
}

export interface StringValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
}

export interface DatabaseInspector {
  columns(): Promise<ColumnDump[]>;
  strings(): Promise<StringValue[]>;
  tables(): Promise<string[]>;
  rows(table: string): Promise<Record<string, unknown>[]>;
  count(table: string): Promise<number>;
  query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const TEXT_TYPES = ['text', 'character varying', 'character', 'jsonb', 'json', 'ARRAY'];
const SCHEMA = 'public';

export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...flattenStrings(entry)]);
  }
  return [];
}

export async function inspectDatabase(database: Database): Promise<DatabaseInspector> {
  if (database.kind !== 'postgres' || database.adminUrl === null) {
    throw new Error('database inspection needs Postgres mode (set E2E_POSTGRES_URL)');
  }
  const client = new pg.Client({ connectionString: database.adminUrl });
  await client.connect();

  const query = async (
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    const result = await client.query(sql, [...params]);
    return result.rows as Record<string, unknown>[];
  };

  const tables = async (): Promise<string[]> =>
    (
      await query(
        `select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
        [SCHEMA],
      )
    ).map((row) => String(row.table_name));

  const columns = async (): Promise<ColumnDump[]> => {
    const described = await query(
      `select table_name, column_name, data_type from information_schema.columns where table_schema = $1 and data_type = any($2) order by table_name, ordinal_position`,
      [SCHEMA, TEXT_TYPES],
    );
    const dumps: ColumnDump[] = [];
    for (const entry of described) {
      const table = String(entry.table_name);
      const column = String(entry.column_name);
      const rows = await query(
        `select ${quoteIdentifier(column)} as value from ${quoteIdentifier(SCHEMA)}.${quoteIdentifier(table)}`,
      );
      dumps.push({
        table,
        column,
        type: String(entry.data_type),
        values: rows.map((row) => row.value),
      });
    }
    return dumps;
  };

  return {
    columns,
    tables,
    strings: async () =>
      (await columns()).flatMap((dump) =>
        dump.values
          .flatMap(flattenStrings)
          .map((value) => ({ table: dump.table, column: dump.column, value })),
      ),
    rows: (table) => query(`select * from ${quoteIdentifier(SCHEMA)}.${quoteIdentifier(table)}`),
    count: async (table) =>
      Number(
        (
          await query(
            `select count(*)::int as count from ${quoteIdentifier(SCHEMA)}.${quoteIdentifier(table)}`,
          )
        )[0]?.count ?? 0,
      ),
    query,
    close: () => client.end(),
  };
}

export const MARKER_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be'] as const;
export type MarkerEncoding = (typeof MARKER_ENCODINGS)[number];

export interface ScanHit {
  readonly file: string;
  readonly encodings: readonly MarkerEncoding[];
}

export function markerBytes(marker: string): Record<MarkerEncoding, Buffer> {
  const le = Buffer.from(marker, 'utf16le');
  const be = Buffer.from(le);
  be.swap16();
  return { 'utf-8': Buffer.from(marker, 'utf8'), 'utf-16le': le, 'utf-16be': be };
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

export async function scanBytes(dir: string, marker: string): Promise<ScanHit[]> {
  if (marker === '') throw new Error('the marker must not be empty');
  const needles = markerBytes(marker);
  const hits: ScanHit[] = [];
  for await (const file of walk(dir)) {
    const content = await readFile(file).catch(() => null);
    if (content === null) continue;
    const found = MARKER_ENCODINGS.filter((encoding) => content.includes(needles[encoding]));
    if (found.length > 0) hits.push({ file, encodings: found });
  }
  return hits;
}
