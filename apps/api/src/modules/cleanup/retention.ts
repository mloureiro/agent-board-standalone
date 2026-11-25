import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import { task, transcriptRun } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import { lockTask, recordServerEvent, transitionTask, type TaskRow } from '../tasks/index.js';

export const DONE_ARCHIVE_DAYS = 7;
export const CLOSED_TRANSCRIPT_DAYS = 14;
export const DONE_TRANSCRIPT_DAYS = 28;

const DAY_MS = 24 * 60 * 60_000;

export const daysBefore = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * DAY_MS);

const isStaleDone = (row: TaskRow, cutoff: Date): boolean =>
  row.status === 'done' &&
  !row.closed &&
  row.createdBy !== 'intake' &&
  row.dedupeKey === null &&
  row.updatedAt < cutoff;

export const archiveStaleDone = async (tx: ScopedDatabase, now: Date): Promise<number> => {
  const cutoff = daysBefore(now, DONE_ARCHIVE_DAYS);
  const stale = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.status, 'done'),
        eq(task.closed, false),
        ne(task.createdBy, 'intake'),
        isNull(task.dedupeKey),
        lt(task.updatedAt, cutoff),
      ),
    );
  let archived = 0;
  for (const { id } of stale) {
    const current = await lockTask(tx, id);
    if (!isStaleDone(current, cutoff)) continue;
    await recordServerEvent(tx, id, { type: 'archived', days: DONE_ARCHIVE_DAYS }, null);
    await transitionTask(tx, current, {
      by: 'user',
      set: { closed: true, closedAt: now, updatedAt: now },
    });
    archived += 1;
  }
  return archived;
};

export const deleteOldTranscripts = async (tx: ScopedDatabase, now: Date): Promise<number> => {
  const closedCutoff = daysBefore(now, CLOSED_TRANSCRIPT_DAYS);
  const doneCutoff = daysBefore(now, DONE_TRANSCRIPT_DAYS);
  const old = tx
    .select({ id: task.id })
    .from(task)
    .where(
      or(
        and(
          eq(task.closed, true),
          lt(sql`coalesce(${task.closedAt}, ${task.updatedAt})`, closedCutoff),
        ),
        and(eq(task.status, 'done'), eq(task.closed, false), lt(task.updatedAt, doneCutoff)),
      ),
    );
  const gone = await tx
    .delete(transcriptRun)
    .where(inArray(transcriptRun.taskId, old))
    .returning({ id: transcriptRun.id });
  return gone.length;
};
