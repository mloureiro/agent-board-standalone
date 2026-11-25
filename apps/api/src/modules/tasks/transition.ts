import { randomBytes } from 'node:crypto';

import type { TaskStatus } from '@agent-board/contract';
import { and, eq } from 'drizzle-orm';

import { note, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { edgePosition } from './positions.js';
import { recordServerEvent } from './server-events.js';
import type { TaskRow, TaskValues, Transition } from './types.js';

const keepsPause = (from: TaskStatus, to: TaskStatus): boolean =>
  (from === 'todo' && (to === 'todo' || to === 'running')) ||
  (from === 'running' && to === 'running');

export const requireNotIntoWaiting = (current: TaskRow, to: TaskStatus): void => {
  if (to === 'waiting' && current.status !== 'waiting')
    throw new ApiError('bad-request', 'only a running agent puts a task in waiting');
};

const handBackPendingMessages = async (
  tx: ScopedDatabase,
  current: TaskRow,
  to: TaskStatus | undefined,
  userStop: boolean,
): Promise<TaskValues | undefined> => {
  const handedOver = await tx
    .update(note)
    .set({ pending: false })
    .where(and(eq(note.taskId, current.id), eq(note.pending, true)))
    .returning({ id: note.id });
  const endsRunWithoutAnswer = to === 'needs-me' || to === 'done' || to === 'waiting';
  if (userStop || !current.inboxRead || handedOver.length === 0 || !endsRunWithoutAnswer)
    return undefined;
  await recordServerEvent(tx, current.id, { type: 'late-message' }, null);
  return {
    next: current.sessionId ? 'resume' : 'fresh',
    openQuestionNoteId: null,
    wakeAt: null,
    waitCheck: false,
  };
};

export const transitionTask = async (
  tx: ScopedDatabase,
  current: TaskRow,
  change: Transition,
): Promise<TaskRow> => {
  const leavingRunning =
    current.status === 'running' && (change.to ?? current.status) !== 'running';
  const handedBack = leavingRunning
    ? await handBackPendingMessages(tx, current, change.to, change.userStop === true)
    : undefined;
  const to = handedBack ? 'todo' : (change.to ?? current.status);
  const moved = to !== current.status;
  if (change.by !== 'user' && moved && current.proposed)
    throw new ApiError('forbidden', 'an agent proposed this task; only the user starts it');
  if (current.proposed && to === 'todo' && change.start === undefined)
    throw new ApiError('forbidden', 'an agent proposed this task; start it first');
  const now = new Date();
  const values: TaskValues = { status: to, updatedAt: now };
  if (moved) values.movedBy = change.by;
  if (to !== 'needs-me') values.openQuestionNoteId = null;
  if (!keepsPause(current.status, to)) values.pausedAt = null;
  if (current.status === 'waiting' && to === 'todo') {
    values.wokenAt = now;
    values.next = current.sessionId ? 'resume' : 'fresh';
  } else if (!keepsPause(current.status, to)) values.wokenAt = null;
  if (to !== 'waiting') {
    values.wakeAt = null;
    values.waitCheck = false;
  }
  if (change.start !== undefined) {
    values.input = change.start.input;
    values.createdBy = 'user';
    values.proposed = false;
  }
  if (to === 'running' && current.status !== 'running') {
    values.runStartedAt = now;
    values.runId = randomBytes(16).toString('base64url');
    values.lastActiveAt = now;
    values.lane = null;
    values.borrowed = false;
  }
  if (to !== 'running') {
    values.runStartedAt = null;
    values.runId = null;
    values.stopRequestedAt = null;
    values.stopMessageId = null;
    values.inboxRead = false;
  }
  if (to !== 'todo') values.notBefore = null;
  if (to === 'done' || to === 'backlog' || change.set?.closed === true) {
    values.watches = null;
    values.watchStops = [];
  }
  const place = handedBack ? 'top' : (change.place ?? (moved ? 'bottom' : undefined));
  if (typeof place === 'number') values.position = place;
  else if (place !== undefined)
    values.position = await edgePosition(tx, current.projectId, to, place);
  const [row] = await tx
    .update(task)
    .set({ ...values, ...change.set, ...handedBack })
    .where(eq(task.id, current.id))
    .returning();
  return row!;
};
