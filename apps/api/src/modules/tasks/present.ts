import type { UiTaskListItem, WireTask, WireTaskPr } from '@agent-board/contract';
import { asc, desc, inArray } from 'drizzle-orm';

import { note, taskPr } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import type { TaskRow } from './types.js';
import { toUiTask, toWireTask } from './wire.js';

type UiTask = ReturnType<typeof toUiTask>;

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
      context: null,
    };
  });
};
