import { asc, eq, sql } from 'drizzle-orm';

import { schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { lockTask } from '../tasks/queries.js';
import type { TaskRow } from '../tasks/types.js';
import type { ScheduleRow, ScheduleView } from './types.js';

const selectViews = (tx: ScopedDatabase) =>
  tx
    .select({ row: schedule, pendingNotBefore: task.notBefore })
    .from(schedule)
    .leftJoin(task, eq(task.id, schedule.occurrenceTaskId));

export const viewOf = async (tx: ScopedDatabase, id: string): Promise<ScheduleView> => {
  const [found] = await selectViews(tx).where(eq(schedule.id, id));
  if (!found) throw new ApiError('not-found', 'no such schedule');
  return { ...found.row, pendingNotBefore: found.pendingNotBefore };
};

export const listSchedules = async (
  tx: ScopedDatabase,
  options: { projectId?: string | undefined } = {},
): Promise<ScheduleView[]> => {
  const found = await selectViews(tx)
    .where(options.projectId === undefined ? undefined : eq(schedule.projectId, options.projectId))
    .orderBy(
      sql`${schedule.endedAt} is not null`,
      sql`${schedule.pausedAt} is not null`,
      sql`${task.notBefore} asc nulls first`,
      asc(schedule.lastOccurrenceAt),
      asc(schedule.createdAt),
    );
  return found.map(({ row, pendingNotBefore }) => ({ ...row, pendingNotBefore }));
};

export const lockWithOccurrence = async (
  tx: ScopedDatabase,
  id: string,
): Promise<{ row: ScheduleRow; pending: TaskRow | undefined }> => {
  const [unlocked] = await tx.select().from(schedule).where(eq(schedule.id, id));
  if (!unlocked) throw new ApiError('not-found', 'no such schedule');
  const pending =
    unlocked.occurrenceTaskId === null ? undefined : await lockTask(tx, unlocked.occurrenceTaskId);
  const [row] = await tx.select().from(schedule).where(eq(schedule.id, id)).for('update');
  if (!row || row.occurrenceTaskId !== unlocked.occurrenceTaskId)
    throw new ApiError('conflict', 'the schedule changed while it was being edited; try again');
  return { row, pending };
};
