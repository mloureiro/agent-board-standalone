import type { ServerServices } from '../context.js';
import type { ScopedDatabase } from '../modules/database/index.js';
import { announceTaskChange } from '../modules/events/index.js';

export const taskWriter =
  ({ database, events }: ServerServices) =>
  async <T>(owner: string, work: (tx: ScopedDatabase) => Promise<T>): Promise<T> => {
    const result = await database.withOwner(owner, work);
    await announceTaskChange(events, owner);
    return result;
  };
