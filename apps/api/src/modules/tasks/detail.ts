import type { UiTaskDetail } from '@agent-board/contract';
import { asc, eq } from 'drizzle-orm';

import { note, task } from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';
import { toThreadNote } from './notes.js';
import { presentUiTasks } from './present.js';
import { getTask } from './queries.js';

export const taskDetail = async (tx: ScopedDatabase, id: string): Promise<UiTaskDetail> => {
  const current = await getTask(tx, id);
  const followUps = await tx
    .select()
    .from(task)
    .where(eq(task.parentId, id))
    .orderBy(asc(task.createdAt), asc(task.id));
  const parent = current.parentId === null ? undefined : await getTask(tx, current.parentId);
  const thread = await tx
    .select()
    .from(note)
    .where(eq(note.taskId, id))
    .orderBy(asc(note.createdAt), asc(note.id));
  const shown = await presentUiTasks(tx, [
    current,
    ...(parent === undefined ? [] : [parent]),
    ...followUps,
  ]);
  const firstFollowUp = parent === undefined ? 1 : 2;
  return {
    task: shown[0]!,
    thread: thread.map(toThreadNote),
    followUps: shown.slice(firstFollowUp),
    parent: parent === undefined ? null : shown[1]!,
  };
};
