import { AsyncLocalStorage } from 'node:async_hooks';

import * as schema from '../db/schema/index.js';
import type { Database, ScopedDatabase } from '../modules/database/index.js';
import type { SessionMethod } from './sessions.js';

export const ensureUser = async (
  tx: ScopedDatabase,
  username: string,
  source: SessionMethod | null,
): Promise<void> => {
  await tx.insert(schema.appUser).values({ username, source }).onConflictDoNothing();
  await tx.insert(schema.project).values({ isDefault: true, position: 0 }).onConflictDoNothing();
};

const writes = new AsyncLocalStorage<true>();

export const asWrite = <T>(isWrite: boolean, work: () => T): T =>
  isWrite ? writes.run(true, work) : work();

export const provisioningDatabase = (database: Database, username: string): Database => ({
  kind: database.kind,
  withSystem: (work) => database.withSystem(work),
  close: () => database.close(),
  withOwner: (owner, work) =>
    owner === username && writes.getStore() === true
      ? database.withOwner(owner, async (tx) => {
          await ensureUser(tx, owner, null);
          return work(tx);
        })
      : database.withOwner(owner, work),
});
