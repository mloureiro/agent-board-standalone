import type { UiTaskListItem, WireTask, WireTaskPr } from '@rumo/contract';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { note, taskPr, transcriptEvent, transcriptRun } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import type { TaskRow } from './types.js';
import { toUiTask, toWireTask } from './wire.js';

type UiTask = ReturnType<typeof toUiTask>;

export const leaveOutInput = <T extends { input?: string | undefined }>(
  items: readonly T[],
  leave: boolean,
): (Omit<T, 'input'> & { input?: string | undefined })[] =>
  items.map((item) => {
    const copy: Omit<T, 'input'> & { input?: string | undefined } = { ...item };
    if (leave) delete copy.input;
    return copy;
  });

const prsOf = async (
  tx: ScopedDatabase,
  rows: readonly TaskRow[],
): Promise<Map<string, WireTaskPr[]>> => {
  const grouped = new Map<string, WireTaskPr[]>();
  if (rows.length === 0) return grouped;
  const found = await tx
    .select()
    .from(taskPr)
    .where(
      inArray(
        taskPr.taskId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(taskPr.createdAt), asc(taskPr.id));
  for (const pr of found)
    grouped.set(pr.taskId, [
      ...(grouped.get(pr.taskId) ?? []),
      { id: pr.id, pr: pr.pr, state: pr.state },
    ]);
  return grouped;
};

type RunContext = NonNullable<UiTaskListItem['context']>;

const contextsOf = async (
  tx: ScopedDatabase,
  rows: readonly TaskRow[],
): Promise<Map<string, RunContext>> => {
  const found = new Map<string, RunContext>();
  const newest = await tx
    .selectDistinctOn([transcriptRun.taskId], {
      taskId: transcriptRun.taskId,
      runId: transcriptRun.id,
    })
    .from(transcriptRun)
    .where(
      inArray(
        transcriptRun.taskId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(transcriptRun.taskId, desc(transcriptRun.startedAt));
  if (newest.length === 0) return found;
  const latest = await tx
    .selectDistinctOn([transcriptEvent.runId], {
      runId: transcriptEvent.runId,
      seq: transcriptEvent.seq,
      at: transcriptEvent.at,
      data: transcriptEvent.data,
    })
    .from(transcriptEvent)
    .where(
      and(
        eq(transcriptEvent.kind, 'context'),
        inArray(
          transcriptEvent.runId,
          newest.map((run) => run.runId),
        ),
      ),
    )
    .orderBy(transcriptEvent.runId, desc(transcriptEvent.seq));
  const byRun = new Map(latest.map((event) => [event.runId, event]));
  for (const run of newest) {
    const event = byRun.get(run.runId);
    if (event !== undefined)
      found.set(run.taskId, {
        at: event.at.toISOString(),
        runId: event.runId,
        seq: event.seq,
        data: event.data,
      });
  }
  return found;
};

export const presentWireTasks = async (
  tx: ScopedDatabase,
  rows: readonly TaskRow[],
): Promise<WireTask[]> => {
  const prs = await prsOf(tx, rows);
  return rows.map((row) => toWireTask(row, prs.get(row.id)));
};

export const presentUiTasks = async (
  tx: ScopedDatabase,
  rows: readonly TaskRow[],
): Promise<UiTask[]> => {
  const prs = await prsOf(tx, rows);
  return rows.map((row) => toUiTask(row, prs.get(row.id)));
};

export const presentListItems = async (
  tx: ScopedDatabase,
  rows: readonly TaskRow[],
): Promise<UiTaskListItem[]> => {
  const tasks = await presentUiTasks(tx, rows);
  if (rows.length === 0) return [];
  const latest = await tx
    .selectDistinctOn([note.taskId], {
      taskId: note.taskId,
      createdAt: note.createdAt,
      preview: note.preview,
      author: note.author,
      kind: note.kind,
    })
    .from(note)
    .where(
      inArray(
        note.taskId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(note.taskId, desc(note.createdAt));
  const byTask = new Map(latest.map((row) => [row.taskId, row]));
  const contexts = await contextsOf(tx, rows);
  return tasks.map((entry) => {
    const last = byTask.get(entry.id);
    return {
      ...entry,
      lastNote:
        last === undefined
          ? null
          : {
              createdAt: last.createdAt.toISOString(),
              preview: last.preview,
              author: last.author,
              kind: last.kind,
            },
      context: contexts.get(entry.id) ?? null,
    };
  });
};
