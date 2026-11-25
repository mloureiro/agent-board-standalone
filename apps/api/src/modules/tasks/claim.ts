import { and, count, eq, inArray, ne } from 'drizzle-orm';

import { schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { lockTask } from './queries.js';
import { transitionTask } from './transition.js';
import type { TaskRow } from './types.js';

export const isScheduleFull = async (
  tx: ScopedDatabase,
  scheduleId: string,
  taskId: string,
): Promise<boolean> => {
  const [limited] = await tx
    .select({ maxConcurrent: schedule.maxConcurrent })
    .from(schedule)
    .where(eq(schedule.id, scheduleId))
    .for('update');
  if (limited?.maxConcurrent == null) return false;
  const [underway] = await tx
    .select({ n: count() })
    .from(task)
    .where(
      and(
        eq(task.scheduleId, scheduleId),
        ne(task.id, taskId),
        inArray(task.status, ['running', 'waiting']),
      ),
    );
  return (underway?.n ?? 0) >= limited.maxConcurrent;
};

const refusal = async (
  tx: ScopedDatabase,
  current: TaskRow,
  machine: string,
): Promise<string | undefined> => {
  if (current.status !== 'todo') return `the task is ${current.status}, not todo`;
  if (current.closed) return 'the task is closed';
  if (current.proposed || current.createdBy === 'agent')
    return 'an agent proposed this task; the user has to start it first';
  if (current.notBefore !== null && current.notBefore.getTime() > Date.now())
    return 'the task is not due yet';
  const pinnedElsewhere =
    current.machine !== null &&
    current.machine !== machine &&
    (current.directoryId !== null ||
      current.legacyDirectory !== null ||
      (current.next === 'resume' && current.sessionId !== null));
  if (pinnedElsewhere) return `the task is pinned to ${current.machine}`;
  if (current.scheduleId !== null && (await isScheduleFull(tx, current.scheduleId, current.id)))
    return 'the schedule has no free slot';
  return undefined;
};

export const claimTask = async (
  tx: ScopedDatabase,
  id: string,
  machine: string,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  const refused = await refusal(tx, current, machine);
  if (refused !== undefined) throw new ApiError('conflict', refused);
  return transitionTask(tx, current, { to: 'running', by: 'machine', set: { machine } });
};
