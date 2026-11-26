import type { ServerServices } from '../context.js';
import type { ScopedDatabase } from '../modules/database/index.js';
import { announceTaskChange } from '../modules/events/index.js';

const projectIdOf = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined;
  const { projectId, task } = result as { projectId?: unknown; task?: unknown };
  if (typeof projectId === 'string') return projectId;
  return task === undefined ? undefined : projectIdOf(task);
};

export const taskWriter =
  ({ database, events }: ServerServices) =>
  async <T>(owner: string, work: (tx: ScopedDatabase) => Promise<T>): Promise<T> => {
    const result = await database.withOwner(owner, work);
    await announceTaskChange(events, owner, projectIdOf(result));
    return result;
  };
