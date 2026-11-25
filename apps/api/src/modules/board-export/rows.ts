import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { columnsOf, type TableSpec } from './tables.js';

export type Json = Record<string, unknown>;

export const toExportRow = (spec: TableSpec, stored: Json): Json => {
  const row: Json = {};
  for (const [exportKey, column] of spec.fields) {
    const value = stored[column];
    row[exportKey] = value instanceof Date ? value.toISOString() : value;
  }
  return row;
};

const isTimestamp = (column: AnyPgColumn | undefined): boolean => column?.dataType === 'date';

export const toInsertValues = (spec: TableSpec, owner: string, row: Json): Json => {
  const columns = columnsOf(spec);
  const values: Json = spec.exported === 'user' ? { username: owner } : { owner };
  for (const [exportKey, column] of spec.fields) {
    const value = row[exportKey];
    values[column] =
      isTimestamp(columns[column]) && typeof value === 'string' ? new Date(value) : value;
  }
  return values;
};

export const parentsFirst = (spec: TableSpec, rows: readonly Json[]): Json[] => {
  const parentKey = spec.parent;
  if (parentKey === null) return [...rows];
  const idKey = spec.fields.find(([, column]) => column === spec.key[0])?.[0] ?? 'id';
  const byId = new Map(rows.map((row) => [String(row[idKey]), row]));
  const ordered: Json[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (row: Json): void => {
    const id = String(row[idKey]);
    if (state.has(id)) return;
    state.set(id, 'visiting');
    const parentId = row[parentKey];
    const parent = typeof parentId === 'string' ? byId.get(parentId) : undefined;
    if (parent !== undefined) visit(parent);
    state.set(id, 'done');
    ordered.push(row);
  };
  for (const row of rows) visit(row);
  return ordered;
};
