import type { NoteText } from '@agent-board/contract';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { note, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { addNote } from './notes.js';
import { getTask, lockTask } from './queries.js';
import { transitionTask } from './transition.js';
import type { NoteRow, TaskRow } from './types.js';
import type { TaskCaller } from './update.js';

export const MAX_WAIT_DAYS = 7;

const notHeldBy = (
  current: TaskRow,
  caller: TaskCaller,
  status: 'running' | 'waiting',
  closedCounts = true,
): string | undefined => {
  if (current.status !== status) return `the task is ${current.status}, not ${status}`;
  if (closedCounts && current.closed) return `the task is closed, not ${status}`;
  if (current.machine !== caller.machine)
    return `the task is ${status} on ${current.machine ?? 'no machine'}, not on ${caller.machine}`;
  if (caller.run !== undefined && current.runId !== caller.run)
    return `the task is ${status} in a later run, not in this one`;
  return undefined;
};

const requireRunOf = (current: TaskRow, caller: TaskCaller): void => {
  if (current.status !== 'running')
    throw new ApiError('conflict', `the task is ${current.status}, not running`);
  if (current.machine !== caller.machine)
    throw new ApiError(
      'forbidden',
      `the task runs on ${current.machine ?? 'no machine'}, not on ${caller.machine}`,
    );
  if (caller.run !== undefined && current.runId !== caller.run)
    throw new ApiError('conflict', 'the task is running in a later run, not in this one');
};

const reportedBy = (
  tx: ScopedDatabase,
  taskId: string,
  message: NoteText,
  caller: TaskCaller,
): Promise<NoteRow> =>
  addNote(tx, taskId, {
    author: 'system',
    kind: 'event',
    body: message.body,
    preview: message.preview ?? null,
    by: caller.machine,
  });

export const heartbeatTask = async (
  tx: ScopedDatabase,
  id: string,
  beat: { lane: string; borrowed: boolean },
  caller: TaskCaller,
): Promise<void> => {
  const beaten = await tx
    .update(task)
    .set({ lane: beat.lane, borrowed: beat.borrowed, lastActiveAt: new Date() })
    .where(
      and(
        eq(task.id, id),
        eq(task.status, 'running'),
        eq(task.machine, caller.machine),
        caller.run === undefined ? undefined : eq(task.runId, caller.run),
      ),
    )
    .returning({ id: task.id });
  if (beaten.length === 0) await getTask(tx, id);
};

export const pauseTask = async (
  tx: ScopedDatabase,
  id: string,
  message: NoteText,
  caller: TaskCaller,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  const refused = notHeldBy(current, caller, 'running', false);
  if (refused !== undefined) throw new ApiError('conflict', refused);
  await reportedBy(tx, id, message, caller);
  return transitionTask(tx, current, {
    to: 'todo',
    place: 'top',
    by: 'machine',
    set: { next: current.sessionId ? 'resume' : 'fresh', pausedAt: new Date() },
  });
};

export const failTask = async (
  tx: ScopedDatabase,
  id: string,
  message: NoteText,
  caller: TaskCaller,
): Promise<{ applied: boolean; row: TaskRow }> => {
  const current = await lockTask(tx, id);
  if (notHeldBy(current, caller, 'running') !== undefined) return { applied: false, row: current };
  await reportedBy(tx, id, message, caller);
  return {
    applied: true,
    row: await transitionTask(tx, current, { to: 'needs-me', by: 'machine' }),
  };
};

export const stoppedTask = async (
  tx: ScopedDatabase,
  id: string,
  message: NoteText,
  caller: TaskCaller,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  requireRunOf(current, caller);
  await reportedBy(tx, id, message, caller);
  return transitionTask(tx, current, { to: 'needs-me', by: 'machine', userStop: true });
};

export const waitTask = async (
  tx: ScopedDatabase,
  id: string,
  request: { body: string; preview?: string | null | undefined; wakeAt: Date; check: boolean },
  caller: TaskCaller,
  now: Date = new Date(),
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  const refused = notHeldBy(current, caller, 'running');
  if (refused !== undefined) throw new ApiError('conflict', refused);
  const ahead = request.wakeAt.getTime() - now.getTime();
  if (ahead <= 0) throw new ApiError('bad-request', 'the end of the wait must lie in the future');
  if (ahead > MAX_WAIT_DAYS * 24 * 60 * 60_000)
    throw new ApiError('bad-request', `a wait lasts at most ${MAX_WAIT_DAYS} days`);
  await addNote(tx, id, {
    author: 'agent',
    kind: 'comment',
    body: request.body,
    preview: request.preview ?? null,
    by: caller.machine,
  });
  return transitionTask(tx, current, {
    to: 'waiting',
    by: 'agent',
    set: {
      wakeAt: request.wakeAt,
      waitCheck: request.check,
      next: current.sessionId ? 'resume' : 'fresh',
    },
  });
};

export const wakeTask = async (
  tx: ScopedDatabase,
  id: string,
  message: NoteText,
  caller: TaskCaller,
): Promise<{ applied: boolean; row: TaskRow }> => {
  const current = await lockTask(tx, id);
  if (notHeldBy(current, { machine: caller.machine }, 'waiting') !== undefined)
    return { applied: false, row: current };
  await reportedBy(tx, id, message, caller);
  return {
    applied: true,
    row: await transitionTask(tx, current, { to: 'todo', place: 'top', by: 'machine' }),
  };
};

export const askTask = async (
  tx: ScopedDatabase,
  id: string,
  asked: { body: string; questions: string },
  caller: TaskCaller,
): Promise<NoteRow> => {
  const current = await lockTask(tx, id);
  if (current.proposed)
    throw new ApiError('forbidden', 'an agent proposed this task; only the user starts it');
  const refused = notHeldBy(current, caller, 'running');
  if (refused !== undefined) throw new ApiError('conflict', refused);
  const question = await addNote(tx, id, {
    author: 'agent',
    kind: 'question',
    body: asked.body,
    questions: asked.questions,
    by: caller.machine,
  });
  await transitionTask(tx, current, {
    to: 'needs-me',
    by: 'agent',
    set: { openQuestionNoteId: question.id },
  });
  return question;
};

export interface RunInbox {
  stop: boolean;
  stopMessage?: string;
  messages: NoteRow[];
}

export const readRunInbox = async (
  tx: ScopedDatabase,
  id: string,
  caller: TaskCaller,
): Promise<RunInbox> => {
  const current = await lockTask(tx, id);
  requireRunOf(current, caller);
  if (!current.inboxRead) await tx.update(task).set({ inboxRead: true }).where(eq(task.id, id));
  const messages = await tx
    .select()
    .from(note)
    .where(and(eq(note.taskId, id), eq(note.pending, true)))
    .orderBy(asc(note.createdAt), asc(note.id));
  const stopping = current.stopRequestedAt !== null;
  return {
    stop: stopping,
    ...(stopping && current.stopMessageId !== null ? { stopMessage: current.stopMessageId } : {}),
    messages,
  };
};

export const ackRunMessages = async (
  tx: ScopedDatabase,
  id: string,
  ack: { ids: readonly string[]; stop: boolean },
  caller: TaskCaller,
): Promise<void> => {
  const current = await lockTask(tx, id);
  requireRunOf(current, caller);
  if (ack.ids.length > 0)
    await tx
      .update(note)
      .set({ pending: false, deliveredAt: new Date() })
      .where(and(eq(note.taskId, id), eq(note.pending, true), inArray(note.id, [...ack.ids])));
  if (ack.stop)
    await tx
      .update(task)
      .set({ stopRequestedAt: null, stopMessageId: null })
      .where(eq(task.id, id));
};
