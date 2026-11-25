import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';

import type * as schema from '../../db/schema/index.js';
import type { SystemFunctions } from '../../db/system.js';
import type { DatabaseConfig, DatabaseKind } from './config.js';

export type Schema = typeof schema;

export type ScopedDatabase = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

export interface Database {
  readonly kind: DatabaseKind;
  withOwner<T>(owner: string, work: (tx: ScopedDatabase) => Promise<T>): Promise<T>;
  withSystem<T>(work: (system: SystemFunctions) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type OpenDatabase = (config: DatabaseConfig) => Promise<Database>;

const unavailable = (): never => {
  throw new Error('this database is a stub and runs no queries');
};

export const stubDatabase = (kind: DatabaseKind, close: () => Promise<void>): Database => ({
  kind,
  withOwner: unavailable,
  withSystem: unavailable,
  close,
});

export const openStubDatabase: OpenDatabase = async (config) =>
  stubDatabase(config.kind, async () => undefined);
