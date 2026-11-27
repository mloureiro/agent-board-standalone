import { randomUUID } from 'node:crypto';

import { MAX_TASK_PRS, MAX_TASK_WATCHES, type PrState } from '@rumo/contract';
import { and, count, eq } from 'drizzle-orm';

import { task, taskPr } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { getTask, lockTask } from './queries.js';
import type { TaskRow } from './types.js';

const touch = (tx: ScopedDatabase, id: string) =>
  tx.update(task).set({ updatedAt: new Date() }).where(eq(task.id, id));

const requireMachineOf = (current: TaskRow, machine: string): void => {
  if (current.machine !== machine)
    throw new ApiError(
      'conflict',
      `the task belongs to ${current.machine ?? 'no machine'}, not to ${machine}`,
    );
};

export const addTaskPr = async (tx: ScopedDatabase, id: string, pr: string): Promise<void> => {
  await lockTask(tx, id);
  const [held] = await tx.select({ n: count() }).from(taskPr).where(eq(taskPr.taskId, id));
  if ((held?.n ?? 0) >= MAX_TASK_PRS)
    throw new ApiError('bad-request', `a task holds at most ${MAX_TASK_PRS} pull requests`);
  await tx.insert(taskPr).values({ id: randomUUID(), taskId: id, pr });
  await touch(tx, id);
};

export const removeTaskPr = async (tx: ScopedDatabase, id: string, prId: string): Promise<void> => {
  await lockTask(tx, id);
  const removed = await tx
    .delete(taskPr)
    .where(and(eq(taskPr.taskId, id), eq(taskPr.id, prId)))
    .returning({ id: taskPr.id });
  if (removed.length > 0) await touch(tx, id);
};

export const setTaskPrStates = async (
  tx: ScopedDatabase,
  id: string,
  states: {
    prompt?: PrState | undefined;
    prs?: readonly { id: string; state: PrState }[] | undefined;
  },
): Promise<void> => {
  await getTask(tx, id);
  if (states.prompt !== undefined)
    await tx.update(task).set({ prState: states.prompt }).where(eq(task.id, id));
  for (const { id: prId, state } of states.prs ?? [])
    await tx
      .update(taskPr)
      .set({ state })
      .where(and(eq(taskPr.taskId, id), eq(taskPr.id, prId)));
};

export const setTaskWatches = async (
  tx: ScopedDatabase,
  id: string,
  watches: string | null,
  machine: string,
): Promise<void> => {
  requireMachineOf(await lockTask(tx, id), machine);
  await tx.update(task).set({ watches }).where(eq(task.id, id));
};

export const ackWatchStops = async (
  tx: ScopedDatabase,
  id: string,
  ids: readonly string[],
  machine: string,
): Promise<void> => {
  const current = await lockTask(tx, id);
  requireMachineOf(current, machine);
  const watchStops = current.watchStops.filter((stop) => !ids.includes(stop));
  if (watchStops.length !== current.watchStops.length)
    await tx.update(task).set({ watchStops }).where(eq(task.id, id));
};

export const stopTaskWatch = async (
  tx: ScopedDatabase,
  id: string,
  watchId: string,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.machine === null)
    throw new ApiError('conflict', 'the task has no machine that runs watches');
  if (current.status === 'done' || current.closed)
    throw new ApiError('conflict', 'the task is done or closed');
  if (current.watchStops.includes(watchId)) return current;
  if (current.watchStops.length >= MAX_TASK_WATCHES)
    throw new ApiError(
      'bad-request',
      `${MAX_TASK_WATCHES} stop requests already wait for the machine`,
    );
  const [row] = await tx
    .update(task)
    .set({ watchStops: [...current.watchStops, watchId] })
    .where(eq(task.id, id))
    .returning();
  return row!;
};
