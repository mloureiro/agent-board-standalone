import type { Database, OpenDatabase } from './database.js';
import type { DatabaseConfig } from './config.js';

export interface HoldableDatabase extends Database {
  isOpen(): boolean;
  hold(): Promise<void>;
  resume(): Promise<void>;
}

const HELD = 'the database is on hold';

export const holdableDatabase = (
  initial: Database,
  open: OpenDatabase,
  config: DatabaseConfig,
): HoldableDatabase => {
  let current: Database | null = initial;
  const live = (): Database => {
    if (current === null) throw new Error(HELD);
    return current;
  };
  const closeCurrent = async (): Promise<void> => {
    const closing = current;
    current = null;
    await closing?.close();
  };
  return {
    kind: initial.kind,
    isOpen: () => current !== null,
    withOwner: (owner, work) => live().withOwner(owner, work),
    withSystem: (work) => live().withSystem(work),
    withOwners: (work) => live().withOwners(work),
    ...(initial.vacuum === undefined ? {} : { vacuum: async () => live().vacuum?.() }),
    close: closeCurrent,
    hold: closeCurrent,
    resume: async () => {
      current ??= await open(config);
    },
  };
};
