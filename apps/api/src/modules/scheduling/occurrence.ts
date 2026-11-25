import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import { schedule, task } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import { createTask } from '../tasks/create.js';
import type { TaskRow } from '../tasks/types.js';
import { nextOccurrence } from './rule.js';
import type { ScheduleRow } from './types.js';

const insertOccurrence = async (
  tx: ScopedDatabase,
  row: ScheduleRow,
  at: Date | null,
  now: Date,
): Promise<TaskRow> => {
  const { task: created } = await createTask(
    tx,
    {
      id: randomUUID(),
      title: row.title,
      input: row.input,
      status: 'todo',
      priority: row.priority,
      createdBy: 'user',
      projectId: row.projectId,
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.effort === null ? {} : { effort: row.effort }),
      ...(row.requestedLane === null ? {} : { lane: row.requestedLane }),
      ...(row.autoDone ? { autoDone: true } : {}),
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(row.icon === null ? {} : { icon: row.icon }),
      ...(row.labels === null ? {} : { labels: row.labels }),
      ...(row.machine === null ? {} : { machine: row.machine }),
      ...(row.directoryId === null ? {} : { directoryId: row.directoryId }),
      ...(row.legacyDirectory === null ? {} : { legacyDirectory: row.legacyDirectory }),
      ...(at === null ? {} : { notBefore: at }),
    },
    { scheduleId: row.id },
  );
  await tx
    .update(schedule)
    .set({
      occurrenceTaskId: created.id,
      lastOccurrenceAt: at ?? now,
      remaining: row.remaining === null ? null : row.remaining - 1,
    })
    .where(eq(schedule.id, row.id));
  return created;
};

export const materializeNext = async (
  tx: ScopedDatabase,
  row: ScheduleRow,
  now: Date,
  from?: Date,
): Promise<TaskRow | undefined> => {
  const stopped = async (values: Partial<ScheduleRow>) => {
    await tx
      .update(schedule)
      .set({ occurrenceTaskId: null, ...values })
      .where(eq(schedule.id, row.id));
    return undefined;
  };
  if (row.pausedAt !== null || row.afterScheduleId !== null) return stopped({});
  if (row.remaining === 0) return stopped({ endedAt: now });
  let at: Date | null;
  if (from !== undefined) at = nextOccurrence(row, from, true);
  else if (row.lastOccurrenceAt === null) at = nextOccurrence(row, row.anchorAt, true);
  else {
    at = nextOccurrence(row, row.lastOccurrenceAt, false);
    if (at !== null && at.getTime() < now.getTime()) at = nextOccurrence(row, now, true);
  }
  if (at === null) return stopped({ endedAt: now });
  return insertOccurrence(tx, row, at, now);
};

export const completeOccurrence = async (
  tx: ScopedDatabase,
  taskId: string,
  scheduleId: string,
  now: Date,
): Promise<void> => {
  const [current] = await tx
    .select({ occurrenceTaskId: schedule.occurrenceTaskId })
    .from(schedule)
    .where(eq(schedule.id, scheduleId));
  if (current?.occurrenceTaskId !== taskId) return;
  const [locked] = await tx
    .select()
    .from(schedule)
    .where(eq(schedule.id, scheduleId))
    .for('update');
  if (locked?.occurrenceTaskId === taskId) await materializeNext(tx, locked, now);
};

const triggerAfter = async (tx: ScopedDatabase, scheduleId: string, now: Date): Promise<void> => {
  const dependents = await tx
    .select({ id: schedule.id })
    .from(schedule)
    .where(
      and(
        eq(schedule.afterScheduleId, scheduleId),
        isNull(schedule.endedAt),
        isNull(schedule.pausedAt),
      ),
    )
    .orderBy(asc(schedule.id));
  for (const { id } of dependents) {
    const [dependent] = await tx.select().from(schedule).where(eq(schedule.id, id)).for('update');
    if (
      !dependent ||
      dependent.endedAt !== null ||
      dependent.pausedAt !== null ||
      dependent.occurrenceTaskId !== null
    )
      continue;
    const at = new Date(now.getTime() + (dependent.afterDelayMs ?? 0));
    if (dependent.remaining === 0 || (dependent.until !== null && at > dependent.until)) {
      await tx.update(schedule).set({ endedAt: now }).where(eq(schedule.id, id));
      continue;
    }
    await insertOccurrence(tx, dependent, dependent.afterDelayMs ? at : null, now);
  }
};

export const occurrenceFinished = async (
  tx: ScopedDatabase,
  finished: Pick<TaskRow, 'id' | 'scheduleId' | 'occurrenceFinishedAt'>,
  now: Date,
): Promise<void> => {
  if (finished.scheduleId === null || finished.occurrenceFinishedAt !== null) return;
  await tx.update(task).set({ occurrenceFinishedAt: now }).where(eq(task.id, finished.id));
  await triggerAfter(tx, finished.scheduleId, now);
};
