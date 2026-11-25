import { PRIORITIES, type Priority, type TaskStatus } from '@agent-board/contract';
import { and, eq, ne } from 'drizzle-orm';

import { task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { edgePosition } from './positions.js';
import { RECENT_FIRST_STATUSES, lockTask } from './queries.js';
import { recordServerEvent } from './server-events.js';
import { requireNotIntoWaiting, transitionTask } from './transition.js';
import type { TaskMove, TaskOptions, TaskRow } from './types.js';

export const droppedPriority = (
  own: Priority,
  above: Priority | undefined,
  below: Priority | undefined,
): Priority => {
  const rank = (priority: Priority) => PRIORITIES.indexOf(priority);
  const fitsAbove = above === undefined || rank(above) <= rank(own);
  const fitsBelow = below === undefined || rank(own) <= rank(below);
  if (fitsAbove && fitsBelow) return own;
  return above ?? below ?? own;
};

const isRecentFirst = (status: TaskStatus): boolean =>
  (RECENT_FIRST_STATUSES as readonly TaskStatus[]).includes(status);

const neighbourOf = async (
  tx: ScopedDatabase,
  current: TaskRow,
  status: TaskStatus,
  id: string | undefined,
) => {
  if (id === undefined) return undefined;
  const [row] = await tx
    .select({ position: task.position, priority: task.priority })
    .from(task)
    .where(
      and(
        eq(task.id, id),
        eq(task.status, status),
        eq(task.projectId, current.projectId),
        ne(task.id, current.id),
      ),
    );
  return row;
};

export const moveTask = async (
  tx: ScopedDatabase,
  input: TaskMove,
  by: string,
  options: TaskOptions = {},
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  if (current.status === 'running' && input.status !== 'running')
    throw new ApiError('conflict', 'the task is running: wait until it reports back');
  if (current.status !== 'running' && input.status === 'running')
    throw new ApiError('bad-request', 'only a worker moves a task to running');
  requireNotIntoWaiting(current, input.status);
  const placed = !isRecentFirst(input.status);
  const above = placed ? await neighbourOf(tx, current, input.status, input.afterId) : undefined;
  const below = placed ? await neighbourOf(tx, current, input.status, input.beforeId) : undefined;
  const priority = droppedPriority(current.priority, above?.priority, below?.priority);
  const upper = above?.priority === priority ? above.position : undefined;
  const lower = below?.priority === priority ? below.position : undefined;
  let position: number;
  if (upper !== undefined && lower !== undefined) position = (upper + lower) / 2;
  else if (lower !== undefined) position = lower - 1;
  else if (upper !== undefined) position = upper + 1;
  else position = await edgePosition(tx, current.projectId, input.status, 'bottom');
  let start: { input: string } | undefined;
  if (current.proposed && input.status === 'todo') {
    if (input.startInput === undefined)
      throw new ApiError(
        'bad-request',
        'starting a proposal needs its prompt sealed again as yours',
      );
    start = { input: input.startInput };
  }
  const row = await transitionTask(
    tx,
    current,
    { to: input.status, place: position, by: 'user', set: { priority }, start },
    options,
  );
  if (current.status !== input.status)
    await recordServerEvent(
      tx,
      current.id,
      { type: 'moved', from: current.status, to: input.status },
      by,
    );
  if (current.priority !== priority)
    await recordServerEvent(
      tx,
      current.id,
      { type: 'priority', from: current.priority, to: priority },
      by,
    );
  return row;
};
