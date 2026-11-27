import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  parseBoardExportLine,
  type BoardExportHeader,
  type BoardExportRecord,
} from '@rumo/contract';
import { and, eq } from 'drizzle-orm';

import { appUser } from '../../db/schema/index.js';
import type { Database, ScopedDatabase } from '../database/index.js';
import { parentsFirst, toInsertValues, type Json } from './rows.js';
import { countNameOf, ownerColumn, specOfRecord, TABLE_SPECS, type TableSpec } from './tables.js';

export class BoardImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardImportRefusal';
  }
}

export interface BoardFile {
  header: BoardExportHeader;
  owners: string[];
  rows: Map<string, Map<TableSpec, Json[]>>;
}

export interface OwnerCounts {
  owner: string;
  counts: { table: string; count: number }[];
}

export interface ImportOptions {
  noLoginUser: string | null;
}

const MAX_INSERT_ROWS = 200;
const MAX_INSERT_BYTES = 4 * 1024 * 1024;

export const readBoardFile = async (path: string): Promise<BoardFile> => {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: BoardExportHeader | null = null;
  const rows: BoardFile['rows'] = new Map();
  let index = 0;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const parsed = parseBoardExportLine(line, index);
    index += 1;
    if ('format' in parsed) {
      header = parsed;
      continue;
    }
    const record: BoardExportRecord = parsed;
    const spec = specOfRecord({ table: record.table, row: record.row as { kind?: string } });
    if (spec === undefined) throw new BoardImportRefusal(`line ${index}: unknown table`);
    const perOwner = rows.get(record.owner) ?? new Map<TableSpec, Json[]>();
    rows.set(record.owner, perOwner);
    const list = perOwner.get(spec) ?? [];
    list.push(record.row as Json);
    perOwner.set(spec, list);
  }
  if (header === null) throw new BoardImportRefusal('the file holds no header line');
  return { header, owners: [...rows.keys()], rows };
};

const chunked = (rows: readonly Json[]): Json[][] => {
  const chunks: Json[][] = [];
  let current: Json[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (
      current.length > 0 &&
      (current.length >= MAX_INSERT_ROWS || bytes + size > MAX_INSERT_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const causeMessage = (error: unknown): string => {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  const facts = current as { message?: string; constraint?: string } | undefined;
  const constraint = facts?.constraint === undefined ? '' : ` (${facts.constraint})`;
  return `${facts?.message ?? String(current)}${constraint}`;
};

const insertTable = async (
  tx: ScopedDatabase,
  owner: string,
  spec: TableSpec,
  rows: readonly Json[],
): Promise<void> => {
  try {
    for (const chunk of chunked(parentsFirst(spec, rows))) {
      await tx
        .insert(spec.table)
        .values(chunk.map((row) => toInsertValues(spec, owner, row)) as never);
    }
  } catch (error) {
    throw new BoardImportRefusal(
      `owner ${owner}, ${countNameOf(spec)}: the database refused the rows: ${causeMessage(error)}`,
    );
  }
};

const countStored = async (tx: ScopedDatabase, owner: string, spec: TableSpec): Promise<number> =>
  tx.$count(spec.table, and(eq(ownerColumn(spec), owner), spec.where ?? undefined));

const importOwner = async (
  tx: ScopedDatabase,
  owner: string,
  tables: Map<TableSpec, Json[]>,
): Promise<OwnerCounts> => {
  for (const spec of TABLE_SPECS) {
    const rows = tables.get(spec);
    if (rows !== undefined) await insertTable(tx, owner, spec, rows);
  }
  const counts: OwnerCounts['counts'] = [];
  for (const spec of TABLE_SPECS) {
    const expected = tables.get(spec)?.length ?? 0;
    if (expected === 0) continue;
    const stored = await countStored(tx, owner, spec);
    if (stored !== expected)
      throw new BoardImportRefusal(
        `count check failed for owner ${owner}, ${countNameOf(spec)}: file ${expected}, target ${stored}`,
      );
    counts.push({ table: countNameOf(spec), count: stored });
  }
  return { owner, counts };
};

const refuseOwners = (board: BoardFile, options: ImportOptions): void => {
  if (board.owners.length === 0) throw new BoardImportRefusal('the file holds no rows');
  for (const owner of board.owners) {
    const users = board.rows.get(owner)?.get(TABLE_SPECS[0]!)?.length ?? 0;
    if (users !== 1)
      throw new BoardImportRefusal(
        `owner ${owner} needs exactly one user row, the file has ${users}`,
      );
    if (options.noLoginUser !== null && owner !== options.noLoginUser)
      throw new BoardImportRefusal(
        `owner "${owner}" is not the NO_LOGIN_USER "${options.noLoginUser}": content keys derive from the owner name, so a different name would open nothing`,
      );
  }
};

export const importBoard = async (
  database: Database,
  board: BoardFile,
  options: ImportOptions,
): Promise<OwnerCounts[]> => {
  refuseOwners(board, options);
  return database.withOwners(async (scopes) => {
    for (const owner of board.owners) {
      const held = await scopes.as(owner, (tx) =>
        tx.select({ username: appUser.username }).from(appUser).where(eq(appUser.username, owner)),
      );
      if (held.length > 0)
        throw new BoardImportRefusal(`the target already holds the owner "${owner}"`);
    }
    const reports: OwnerCounts[] = [];
    for (const owner of board.owners) {
      const tables = board.rows.get(owner) as Map<TableSpec, Json[]>;
      reports.push(await scopes.as(owner, (tx) => importOwner(tx, owner, tables)));
    }
    return reports;
  });
};

export const formatImportReport = (reports: readonly OwnerCounts[]): string =>
  [
    `import finished for ${reports.length} owner(s)`,
    ...reports.flatMap(({ owner, counts }) => [
      `owner ${owner}`,
      ...counts.map(({ table, count }) => `  ${table}: ${count}`),
    ]),
    'count check passed',
    '',
  ].join('\n');
