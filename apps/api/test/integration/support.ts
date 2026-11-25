import { randomUUID } from 'node:crypto';

import { getTableName, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../src/db/schema/index.js';
import type { Database, ScopedDatabase } from '../../src/modules/database/index.js';

export const envelope = (size = 40): string => `abe1.${'A'.repeat(size)}`;
export const blind = (fill = 'B'): string => `abh1.${fill.repeat(43)}`;

export interface ErrorFacts {
  code: string | undefined;
  constraint: string | undefined;
  message: string;
}

export const databaseError = async (work: Promise<unknown>): Promise<ErrorFacts> => {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error && current.cause instanceof Error) current = current.cause;
    const facts = current as Error & { code?: string; constraint?: string };
    return { code: facts.code, constraint: facts.constraint, message: facts.message };
  }
  throw new Error('the statement was accepted');
};

export const seedUser = async (db: Database, owner: string): Promise<{ projectId: string }> =>
  db.withOwner(owner, async (tx) => {
    await tx.insert(schema.appUser).values({ username: owner });
    const projectId = randomUUID();
    await tx.insert(schema.project).values({ id: projectId, isDefault: true, position: 0 });
    return { projectId };
  });

export const taskValues = (projectId: string, id: string) => ({
  id,
  title: envelope(),
  input: envelope(),
  position: 1,
  projectId,
});

export const camel = (column: string): string =>
  column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export const insertInto = (tx: ScopedDatabase, table: PgTable, values: Record<string, unknown>) =>
  tx.insert(table).values(values as never);

export const tableName = (table: PgTable): string => getTableName(table);

export type Fragment = SQL;

export const rowsOf = async (tx: ScopedDatabase, query: SQL): Promise<Record<string, unknown>[]> =>
  ((await tx.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;

export const catalog = (db: Database, query: SQL) =>
  db.withOwner('catalog-reader', (tx) => rowsOf(tx, query));
