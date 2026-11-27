import { boardExportRecord, type AccountTable, type BoardExportRecord } from '@rumo/contract';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';

import { appUser, directory, note, project, schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { parentsFirst, toExportRow, toInsertValues, type Json } from './rows.js';
import { columnsOf, keyColumns, ownerColumn, specOfAccount, type TableSpec } from './tables.js';

export const PAGE_BYTE_BUDGET = 8 * 1024 * 1024;

export interface ExportPage {
  next: string | null;
  rows: Json[];
}

export interface ImportCounts {
  inserted: number;
  existing: number;
  invalid: number;
  orphaned: number;
}

const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

const encodeCursor = (values: readonly unknown[]): string =>
  Buffer.from(JSON.stringify(values)).toString('base64url');

const parseCursor = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const decodeCursor = (cursor: string, width: number): unknown[] => {
  const parsed = parseCursor(cursor);
  if (
    Array.isArray(parsed) &&
    parsed.length === width &&
    parsed.every((part) => typeof part === 'string' || typeof part === 'number')
  )
    return parsed;
  throw new ApiError('bad-request', 'the cursor does not belong to this table');
};

const afterCursor = (spec: TableSpec, values: readonly unknown[]): SQL => {
  const columns = keyColumns(spec);
  if (columns.length === 1) return gt(columns[0]!, values[0]);
  return sql`(${sql.join(columns, sql`, `)}) > (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
};

export const exportPage = async (
  tx: ScopedDatabase,
  owner: string,
  account: AccountTable,
  cursor: string | undefined,
): Promise<ExportPage> => {
  const spec = specOfAccount(account);
  const keys = keyColumns(spec);
  const conditions: (SQL | undefined)[] = [
    eq(ownerColumn(spec), owner),
    spec.where ?? undefined,
    cursor === undefined ? undefined : afterCursor(spec, decodeCursor(cursor, keys.length)),
  ];
  const stored = (await tx
    .select()
    .from(spec.table)
    .where(and(...conditions))
    .orderBy(...keys.map((key) => asc(key)))
    .limit(spec.pageSize + 1)) as Json[];

  const rows: Json[] = [];
  let bytes = 0;
  let last: Json | null = null;
  let more = stored.length > spec.pageSize;
  for (const row of stored.slice(0, spec.pageSize)) {
    const exported = toExportRow(spec, row);
    bytes += JSON.stringify(exported).length;
    if (rows.length > 0 && bytes > PAGE_BYTE_BUDGET) {
      more = true;
      break;
    }
    rows.push(exported);
    last = row;
  }
  const next =
    more && last !== null
      ? encodeCursor(spec.key.map((name) => last[name] as string | number))
      : null;
  return { next, rows };
};

const unwrapCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  while (current instanceof Error && current.cause instanceof Error) current = current.cause;
  return (current as { code?: string } | undefined)?.code;
};

const validated = (spec: TableSpec, owner: string, row: unknown): Json | null => {
  const parsed = boardExportRecord.safeParse({ owner, table: spec.exported, row });
  if (!parsed.success) return null;
  const record: BoardExportRecord = parsed.data;
  const stored = record.row as Json;
  if (spec.documentKind !== null && stored.kind !== spec.documentKind) return null;
  if (spec.exported === 'device' && stored.kind === 'session') return null;
  return stored;
};

const exists = async (
  tx: ScopedDatabase,
  condition: SQL,
  table: typeof note | typeof task | typeof directory,
) =>
  (
    await tx
      .select({ one: sql<number>`1` })
      .from(table)
      .where(condition)
      .limit(1)
  ).length > 0;

const presentIds = async (
  tx: ScopedDatabase,
  owner: string,
  table: typeof note | typeof task,
  ids: readonly string[],
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const found = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.owner, owner), inArray(table.id, [...ids])));
  return new Set(found.map((row) => row.id));
};

const referencedBy = (rows: readonly Json[], key: string): string[] => [
  ...new Set(rows.map((row) => row[key]).filter((id): id is string => typeof id === 'string')),
];

const projectInUse = async (tx: ScopedDatabase, owner: string, id: string): Promise<boolean> => {
  const [tasks, schedules, directories] = await Promise.all([
    tx.$count(task, and(eq(task.owner, owner), eq(task.projectId, id))),
    tx.$count(schedule, and(eq(schedule.owner, owner), eq(schedule.projectId, id))),
    tx.$count(directory, and(eq(directory.owner, owner), eq(directory.projectId, id))),
  ]);
  return tasks + schedules + directories > 0;
};

const makeRoomForDefault = async (
  tx: ScopedDatabase,
  owner: string,
  rows: Json[],
): Promise<Json[]> => {
  const [current] = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.owner, owner), eq(project.isDefault, true)));
  if (current === undefined) return rows;
  const incoming = rows.find((row) => row.isDefault === true && row.id !== current.id);
  if (incoming === undefined) return rows;
  if (await projectInUse(tx, owner, current.id)) {
    return rows.map((row) => (row === incoming ? { ...row, isDefault: false } : row));
  }
  await tx.delete(project).where(and(eq(project.owner, owner), eq(project.id, current.id)));
  return rows;
};

const settleDeferred = async (
  tx: ScopedDatabase,
  owner: string,
  spec: TableSpec,
  rows: Json[],
): Promise<Json[]> => {
  if (spec.exported === 'project') return makeRoomForDefault(tx, owner, rows);
  if (spec.exported === 'task') {
    const notes = await presentIds(tx, owner, note, referencedBy(rows, 'openQuestionNoteId'));
    return rows.map((row) =>
      typeof row.openQuestionNoteId === 'string' && !notes.has(row.openQuestionNoteId)
        ? { ...row, openQuestionNoteId: null }
        : row,
    );
  }
  if (spec.exported === 'note') {
    const inBatch = new Set(rows.map((row) => String(row.id)));
    const stored = await presentIds(tx, owner, note, referencedBy(rows, 'questionNoteId'));
    return rows.map((row) =>
      typeof row.questionNoteId === 'string' &&
      !stored.has(row.questionNoteId) &&
      !inBatch.has(row.questionNoteId)
        ? { ...row, questionNoteId: null }
        : row,
    );
  }
  if (spec.exported === 'schedule') {
    const tasks = await presentIds(tx, owner, task, referencedBy(rows, 'occurrenceTaskId'));
    return rows.map((row) =>
      typeof row.occurrenceTaskId === 'string' && !tasks.has(row.occurrenceTaskId)
        ? { ...row, occurrenceTaskId: null }
        : row,
    );
  }
  return rows;
};

const directoryExists = (tx: ScopedDatabase, owner: string, row: Json): Promise<boolean> =>
  exists(
    tx,
    and(
      eq(directory.owner, owner),
      eq(directory.id, String(row.directoryId)),
      eq(directory.projectId, String(row.projectId)),
    ) as SQL,
    directory,
  );

const insertOne = async (
  tx: ScopedDatabase,
  spec: TableSpec,
  owner: string,
  row: Json,
): Promise<'inserted' | 'existing' | 'invalid' | 'orphaned'> => {
  if (
    (spec.exported === 'task' || spec.exported === 'schedule') &&
    typeof row.directoryId === 'string' &&
    !(await directoryExists(tx, owner, row))
  )
    return 'orphaned';
  const columns = columnsOf(spec);
  const target = [ownerColumn(spec), ...keyColumns(spec)].filter(
    (column, index, all) => all.indexOf(column) === index,
  );
  try {
    const written = await tx.transaction(async (savepoint) =>
      savepoint
        .insert(spec.table)
        .values(toInsertValues(spec, owner, row) as never)
        .onConflictDoNothing({ target })
        .returning({ key: columns[spec.key[0]!]! }),
    );
    return written.length === 1 ? 'inserted' : 'existing';
  } catch (error) {
    const code = unwrapCode(error);
    if (code === FOREIGN_KEY_VIOLATION) return 'orphaned';
    if (code === CHECK_VIOLATION || code === UNIQUE_VIOLATION) return 'invalid';
    throw error;
  }
};

export const importRows = async (
  tx: ScopedDatabase,
  owner: string,
  account: AccountTable,
  rows: readonly unknown[],
): Promise<ImportCounts> => {
  const spec = specOfAccount(account);
  const counts: ImportCounts = { inserted: 0, existing: 0, invalid: 0, orphaned: 0 };
  const accepted: Json[] = [];
  for (const row of rows) {
    const checked = validated(spec, owner, row);
    if (checked === null) counts.invalid += 1;
    else accepted.push(checked);
  }
  const settled = await settleDeferred(tx, owner, spec, parentsFirst(spec, accepted));
  for (const row of settled) counts[await insertOne(tx, spec, owner, row)] += 1;
  return counts;
};

export const userKeyId = async (tx: ScopedDatabase, owner: string): Promise<string | null> => {
  const [stored] = await tx
    .select({ keyId: appUser.keyId })
    .from(appUser)
    .where(eq(appUser.username, owner));
  return stored?.keyId ?? null;
};
