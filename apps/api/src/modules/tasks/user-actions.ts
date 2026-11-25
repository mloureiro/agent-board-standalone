import type { NoteText, Priority } from '@agent-board/contract';
import { and, eq } from 'drizzle-orm';

import { note, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { createTask } from './create.js';
import { addNote } from './notes.js';
import { getTask, lockTask } from './queries.js';
import { TAKE_BACK_MINUTES, recordServerEvent } from './server-events.js';
import { transitionTask } from './transition.js';
import type { Actor, TaskRow } from './types.js';

const requireNotRunning = (current: TaskRow): void => {
  if (current.status === 'running')
    throw new ApiError('conflict', 'the task is running: wait until it reports back');
};

const continueTask = (tx: ScopedDatabase, current: TaskRow): Promise<TaskRow> =>
  transitionTask(tx, current, {
    to: 'todo',
    place: 'top',
    by: 'user',
    set: { next: current.sessionId ? 'resume' : 'fresh', closed: false, closedAt: null },
  });

const userComment = (
  tx: ScopedDatabase,
  taskId: string,
  message: NoteText,
  actor: Actor,
  pending = false,
) =>
  addNote(tx, taskId, {
    author: 'user',
    kind: 'comment',
    body: message.body,
    preview: message.preview ?? null,
    by: actor.by,
    via: actor.via,
    pending,
  });

export const answerQuestion = async (
  tx: ScopedDatabase,
  input: { id: string; questionNoteId: string; answers: string; message: NoteText },
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  requireNotRunning(current);
  if (current.openQuestionNoteId !== input.questionNoteId)
    throw new ApiError('conflict', 'this question was already answered or replaced');
  const [question] = await tx
    .select({ id: note.id, questions: note.questions })
    .from(note)
    .where(
      and(
        eq(note.id, input.questionNoteId),
        eq(note.taskId, current.id),
        eq(note.kind, 'question'),
      ),
    );
  if (!question?.questions) throw new ApiError('not-found', 'the question is gone');
  await addNote(tx, current.id, {
    author: 'user',
    kind: 'answer',
    body: input.message.body,
    preview: input.message.preview ?? null,
    answers: input.answers,
    questionNoteId: question.id,
    by: actor.by,
    via: actor.via,
  });
  return continueTask(tx, current);
};

export const dismissQuestion = async (
  tx: ScopedDatabase,
  input: { id: string; questionNoteId: string },
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  if (current.openQuestionNoteId !== input.questionNoteId)
    throw new ApiError('conflict', 'this question was already answered or replaced');
  return transitionTask(tx, current, { by: 'user', set: { openQuestionNoteId: null } });
};

export const replyToTask = async (
  tx: ScopedDatabase,
  input: { id: string; message: NoteText; resume: boolean },
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  if (input.resume) requireNotRunning(current);
  await userComment(tx, current.id, input.message, actor);
  return input.resume ? continueTask(tx, current) : getTask(tx, current.id);
};

export const sendToTask = async (
  tx: ScopedDatabase,
  input: { id: string; message: NoteText },
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  if (current.status !== 'running') return replyToTask(tx, { ...input, resume: true }, actor);
  await userComment(tx, current.id, input.message, actor, true);
  return getTask(tx, current.id);
};

export const stopTask = async (
  tx: ScopedDatabase,
  input: { id: string; message?: NoteText | undefined },
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, input.id);
  if (current.status === 'running') {
    const message =
      input.message === undefined
        ? undefined
        : await userComment(tx, current.id, input.message, actor, true);
    const [row] = await tx
      .update(task)
      .set({
        stopRequestedAt: new Date(),
        stopMessageId: message?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(task.id, current.id))
      .returning();
    return row!;
  }
  if (current.status === 'todo' && current.next === 'resume' && !current.closed) {
    await recordServerEvent(
      tx,
      current.id,
      { type: 'moved', from: 'todo', to: 'needs-me' },
      actor.by,
    );
    return transitionTask(tx, current, { to: 'needs-me', by: 'user' });
  }
  if (current.status === 'waiting') {
    await recordServerEvent(
      tx,
      current.id,
      { type: 'moved', from: 'waiting', to: 'backlog' },
      actor.by,
    );
    return transitionTask(tx, current, { to: 'backlog', by: 'user' });
  }
  throw new ApiError(
    'conflict',
    `the task is ${current.status}: only a running, waiting or answered task can be stopped`,
  );
};

export const takeBackTask = async (
  tx: ScopedDatabase,
  id: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.status !== 'running') throw new ApiError('conflict', 'the task is not running');
  const quietMs =
    current.lastActiveAt === null ? Infinity : now.getTime() - current.lastActiveAt.getTime();
  if (quietMs < TAKE_BACK_MINUTES * 60_000)
    throw new ApiError(
      'conflict',
      `the agent was active ${Math.floor(quietMs / 60_000)} minutes ago: a task can be taken back after ${TAKE_BACK_MINUTES} quiet minutes`,
    );
  await recordServerEvent(tx, id, { type: 'taken-back', machine: current.machine }, actor.by);
  return transitionTask(tx, current, { to: 'needs-me', by: 'user', userStop: true });
};

export const markTaskDone = async (
  tx: ScopedDatabase,
  id: string,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  requireNotRunning(current);
  await recordServerEvent(tx, id, { type: 'done' }, actor.by);
  return transitionTask(tx, current, { to: 'done', place: 'top', by: 'user' });
};

export const rerunTask = async (tx: ScopedDatabase, id: string, actor: Actor): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  requireNotRunning(current);
  await recordServerEvent(tx, id, { type: 'rerun' }, actor.by);
  return transitionTask(tx, current, {
    to: 'todo',
    place: 'bottom',
    by: 'user',
    set: {
      next: 'fresh',
      sessionId: null,
      closed: false,
      closedAt: null,
      wokenAt: null,
      watches: null,
      watchStops: [],
    },
  });
};

export const setTaskClosed = async (
  tx: ScopedDatabase,
  id: string,
  closed: boolean,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (closed) requireNotRunning(current);
  await recordServerEvent(tx, id, { type: closed ? 'closed' : 'reopened' }, actor.by);
  return transitionTask(tx, current, {
    by: 'user',
    set: { closed, closedAt: closed ? new Date() : null },
  });
};

export const setTaskPriority = async (
  tx: ScopedDatabase,
  id: string,
  priority: Priority,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.priority === priority) return current;
  await recordServerEvent(
    tx,
    id,
    { type: 'priority', from: current.priority, to: priority },
    actor.by,
  );
  return transitionTask(tx, current, { place: 'bottom', by: 'user', set: { priority } });
};

export const setTaskNotBefore = async (
  tx: ScopedDatabase,
  id: string,
  notBefore: Date | null,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.status !== 'todo')
    throw new ApiError('conflict', `the task is ${current.status}, not todo`);
  await recordServerEvent(
    tx,
    id,
    notBefore === null ? { type: 'start-cleared' } : { type: 'start-set', at: notBefore },
    actor.by,
  );
  return transitionTask(tx, current, { by: 'user', set: { notBefore } });
};

export const wakeTaskNow = async (
  tx: ScopedDatabase,
  id: string,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.status !== 'waiting')
    throw new ApiError('conflict', `the task is ${current.status}, not waiting`);
  await recordServerEvent(tx, id, { type: 'woken' }, actor.by);
  return transitionTask(tx, current, { to: 'todo', place: 'top', by: 'user' });
};

export interface ForkInput {
  id: string;
  parentId: string;
  title: string;
  input: string;
  directoryId: string | null;
  agent?: string | undefined;
}

export const forkTask = async (tx: ScopedDatabase, input: ForkInput): Promise<TaskRow> => {
  const parent = await getTask(tx, input.parentId);
  if (parent.proposed || parent.createdBy === 'agent')
    throw new ApiError('forbidden', 'an agent proposed this task; start it first');
  if (parent.closed) throw new ApiError('conflict', 'a closed task cannot be forked');
  if (parent.sessionId === null || parent.machine === null)
    throw new ApiError('conflict', 'this task has no session on a machine yet: nothing to fork');
  if ((input.agent === undefined) !== (parent.agent === null))
    throw new ApiError('bad-request', 'a fork runs as the agent of its parent and as no other');
  if (input.directoryId !== parent.directoryId)
    throw new ApiError('bad-request', 'a fork runs in the directory of its parent');
  const { task: forked } = await createTask(
    tx,
    {
      id: input.id,
      title: input.title,
      input: input.input,
      status: 'todo',
      createdBy: 'user',
      parentId: parent.id,
      machine: parent.machine,
      projectId: parent.projectId,
      directoryId: parent.directoryId,
      model: parent.model ?? undefined,
      effort: parent.effort ?? undefined,
      lane: parent.requestedLane ?? undefined,
      agent: input.agent,
    },
    { forkOf: parent.id },
  );
  return forked;
};
