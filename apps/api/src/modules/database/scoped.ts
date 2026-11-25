import { sql } from 'drizzle-orm';

import { APP_ROLE, OWNER_SETTING } from '../../db/schema/index.js';
import { systemFunctions } from '../../db/system.js';
import type { Database, ScopedDatabase } from './database.js';

export interface TransactionRunner {
  transaction<T>(work: (tx: ScopedDatabase) => Promise<T>): Promise<T>;
}

export interface ScopeHooks {
  beforeScope?(): void;
  afterScope?(): void;
  switchRole: boolean;
  serialise<T>(work: () => Promise<T>): Promise<T>;
}

const enterScope = async (tx: ScopedDatabase, owner: string, hooks: ScopeHooks): Promise<void> => {
  hooks.beforeScope?.();
  try {
    if (hooks.switchRole) await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(sql`select set_config(${OWNER_SETTING}, ${owner}, true)`);
  } finally {
    hooks.afterScope?.();
  }
};

export const scopedOperations = (
  runner: TransactionRunner,
  hooks: ScopeHooks,
): Pick<Database, 'withOwner' | 'withSystem'> => ({
  withOwner: (owner, work) =>
    hooks.serialise(() =>
      runner.transaction(async (tx) => {
        await enterScope(tx, owner, hooks);
        return work(tx);
      }),
    ),
  withSystem: (work) =>
    hooks.serialise(() =>
      runner.transaction(async (tx) => {
        await enterScope(tx, '', hooks);
        return work(systemFunctions(tx));
      }),
    ),
});
