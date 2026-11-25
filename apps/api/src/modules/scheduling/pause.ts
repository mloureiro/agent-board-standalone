import { asc, count, eq } from 'drizzle-orm';

import { schedule, task, transcriptRun } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import type { TaskRow } from '../tasks/types.js';
import { materializeNext } from './occurrence.js';
import { lockWithOccurrence, viewOf } from './queries.js';
import type { ScheduleView } from './types.js';

export const hasStarted = (row: Pick<TaskRow, 'lastActiveAt' | 'sessionId'>): boolean =>
  row.lastActiveAt !== null || row.sessionId !== null;

export const removePending = async (
  tx: ScopedDatabase,
  pending: TaskRow | undefined,
): Promise<boolean> => {
  if (pending === undefined || pending.status !== 'todo' || hasStarted(pending)) return false;
  const [runs] = await tx
    .select({ n: count() })
    .from(transcriptRun)
    .where(eq(transcriptRun.taskId, pending.id));
  if ((runs?.n ?? 0) > 0) return false;
  await tx
    .update(schedule)
    .set({ occurrenceTaskId: null })
    .where(eq(schedule.occurrenceTaskId, pending.id));
  await tx.delete(task).where(eq(task.id, pending.id));
  return true;
};

export const setPaused = async (
  tx: ScopedDatabase,
  id: string,
  paused: boolean,
  now: Date = new Date(),
): Promise<ScheduleView> => {
  const { row, pending } = await lockWithOccurrence(tx, id);
  if (row.endedAt !== null) throw new ApiError('conflict', 'the schedule has ended');
  if (paused === (row.pausedAt !== null)) return viewOf(tx, id);
  if (paused) {
    const removed = await removePending(tx, pending);
    await tx
      .update(schedule)
      .set({
        pausedAt: now,
        ...(removed ? { remaining: row.remaining === null ? null : row.remaining + 1 } : {}),
      })
      .where(eq(schedule.id, id));
    return viewOf(tx, id);
  }
  const resumed = { ...row, pausedAt: null };
  await tx.update(schedule).set({ pausedAt: null }).where(eq(schedule.id, id));
  const from = row.anchorAt.getTime() > now.getTime() ? row.anchorAt : now;
  if (resumed.occurrenceTaskId === null) await materializeNext(tx, resumed, now, from);
  return viewOf(tx, id);
};

export const removeSchedule = async (tx: ScopedDatabase, id: string): Promise<string> => {
  const { row, pending } = await lockWithOccurrence(tx, id);
  const dependents = await tx
    .select({ id: schedule.id })
    .from(schedule)
    .where(eq(schedule.afterScheduleId, id))
    .orderBy(asc(schedule.id));
  if (dependents.length > 0)
    throw new ApiError(
      'conflict',
      `schedules run after this one (${dependents
        .slice(0, 5)
        .map((dependent) => dependent.id)
        .join(', ')}${dependents.length > 5 ? ', ...' : ''}); remove those first`,
    );
  await removePending(tx, pending);
  await tx.delete(schedule).where(eq(schedule.id, id));
  return row.projectId;
};
