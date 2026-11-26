import { and, eq } from 'drizzle-orm';

import type { Clock } from '../../clock.js';
import { directory } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { lockTask } from './queries.js';
import { occurrenceFinished } from '../scheduling/occurrence.js';
import { recordServerEvent } from './server-events.js';
import { requireNotIntoWaiting, transitionTask } from './transition.js';
import type { Edge, TaskPatchInput, TaskRow, TaskValues } from './types.js';

export interface TaskCaller {
  machine: string;
  run?: string | undefined;
  scheduling?: boolean | undefined;
  clock?: Clock | undefined;
}

const NOT_AUTO_DONE =
  'this task does not finish by itself: move it to needs-me and the user marks it done';

const runRefusal = (current: TaskRow, run: string, moves: boolean): string | undefined => {
  if (current.status === 'running' && current.runId !== run)
    return 'the task is running in a later run, not in this one';
  if (moves && current.status !== 'running')
    return `the task is ${current.status}, no longer running in this run`;
  return undefined;
};

const requireDirectoryOf = async (
  tx: ScopedDatabase,
  current: TaskRow,
  directoryId: string,
): Promise<void> => {
  const [row] = await tx
    .select({ id: directory.id })
    .from(directory)
    .where(and(eq(directory.id, directoryId), eq(directory.projectId, current.projectId)));
  if (!row) throw new ApiError('not-found', 'no such directory');
};

export const updateTask = async (
  tx: ScopedDatabase,
  id: string,
  patch: TaskPatchInput,
  caller: TaskCaller,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  const { run } = caller;
  if (patch.expect !== undefined && patch.expect !== current.status)
    throw new ApiError('conflict', `the task is ${current.status}, not ${patch.expect}`);
  if (run !== undefined) {
    const refused = runRefusal(current, run, patch.status !== undefined);
    if (refused !== undefined) throw new ApiError('conflict', refused);
    if (patch.status === 'done' && !current.autoDone)
      throw new ApiError('forbidden', NOT_AUTO_DONE);
  }
  if (patch.status === 'running' && current.status !== 'running')
    throw new ApiError('bad-request', 'only a claim moves a task to running');
  if (patch.status !== undefined) requireNotIntoWaiting(current, patch.status);
  const set: TaskValues = {};
  if (patch.input !== undefined) set.input = patch.input;
  if (patch.sessionId !== undefined) set.sessionId = patch.sessionId;
  if (patch.next !== undefined) set.next = patch.next;
  if (patch.head !== undefined) set.head = patch.head;
  if (patch.directoryId !== undefined) {
    if (patch.directoryId !== null) await requireDirectoryOf(tx, current, patch.directoryId);
    set.directoryId = patch.directoryId;
  }
  if (patch.notBefore instanceof Date) {
    if ((patch.status ?? current.status) !== 'todo')
      throw new ApiError('conflict', 'only a task in todo can have a start time');
    set.notBefore = patch.notBefore;
  } else if (patch.notBefore === null) set.notBefore = null;
  if (patch.priority !== undefined && patch.priority !== current.priority)
    set.priority = patch.priority;
  if (current.status === 'running') {
    set.pausedAt = null;
    set.wokenAt = null;
  }
  const agentDone = run !== undefined && patch.status === 'done';
  let place: Edge | undefined;
  if (agentDone) place = 'top';
  else if (set.priority !== undefined) place = 'bottom';
  const row = await transitionTask(
    tx,
    current,
    { to: patch.status, place, by: run === undefined ? 'machine' : 'agent', set },
    caller,
  );
  if (agentDone && row.status === 'done')
    await recordServerEvent(tx, id, { type: 'moved', from: 'running', to: 'done' }, caller.machine);
  if (
    caller.scheduling !== false &&
    current.status === 'running' &&
    (row.status === 'needs-me' || row.status === 'done')
  )
    await occurrenceFinished(tx, current, row.updatedAt, row.status);
  return row;
};
