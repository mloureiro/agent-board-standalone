import type { NoteText, Priority } from '@rumo/contract';
import { and, eq } from 'drizzle-orm';

import { directory, project, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { addNote } from './notes.js';
import { edgePosition } from './positions.js';
import { lockTask } from './queries.js';
import { recordServerEvent } from './server-events.js';
import { transitionTask } from './transition.js';
import type { Actor, TaskRow, TaskValues } from './types.js';

export interface TaskSettings {
  priority?: Priority | undefined;
  model?: string | null | undefined;
  effort?: TaskRow['effort'] | undefined;
  lane?: string | null | undefined;
  autoDone?: boolean | undefined;
  icon?: string | null | undefined;
  labels?: string | null | undefined;
  place?: { directoryId: string; machine?: string | undefined } | null | undefined;
  title?: string | undefined;
}

const hasStarted = (current: TaskRow): boolean =>
  current.lastActiveAt !== null || current.sessionId !== null;

const directoryIn = async (
  tx: ScopedDatabase,
  projectId: string,
  directoryId: string,
): Promise<{ machineId: string }> => {
  const [row] = await tx
    .select({ machineId: directory.machineId })
    .from(directory)
    .where(and(eq(directory.id, directoryId), eq(directory.projectId, projectId)));
  if (!row) throw new ApiError('not-found', 'no such directory in the project');
  return row;
};

const placement = (machine: string | null, directoryId: string | null): TaskValues => ({
  machine,
  directoryId,
  legacyDirectory: null,
  legacyHomeWorkdir: null,
  sessionId: null,
  next: 'fresh',
  pausedAt: null,
  wokenAt: null,
  watches: null,
  watchStops: [],
});

export const editPrompt = async (
  tx: ScopedDatabase,
  id: string,
  edit: { title: string; input: string; previous: NoteText },
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.createdBy !== 'user' || current.proposed)
    throw new ApiError('forbidden', 'only a task you created has a prompt you can edit');
  if (current.scheduleId !== null)
    throw new ApiError(
      'conflict',
      'a scheduled occurrence takes its prompt from its schedule: edit the schedule',
    );
  if (hasStarted(current))
    throw new ApiError(
      'conflict',
      'the task has started: its prompt is in its thread now, reply instead',
    );
  if (current.closed || (current.status !== 'todo' && current.status !== 'backlog'))
    throw new ApiError(
      'conflict',
      'the prompt can only be edited while the task waits in todo or backlog',
    );
  await addNote(tx, id, {
    author: 'user',
    kind: 'event',
    body: edit.previous.body,
    preview: edit.previous.preview ?? null,
    by: actor.by,
    via: actor.via,
  });
  const [row] = await tx
    .update(task)
    .set({ title: edit.title, input: edit.input, updatedAt: new Date() })
    .where(eq(task.id, id))
    .returning();
  return row!;
};

export const configureTask = async (
  tx: ScopedDatabase,
  id: string,
  settings: TaskSettings,
  actor: Actor,
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  const { priority, model, effort, lane, autoDone, icon, labels, place, title } = settings;
  if (title !== undefined && current.scheduleId !== null)
    throw new ApiError('conflict', 'a scheduled occurrence takes its title from its schedule');
  if (lane !== undefined && current.status === 'running')
    throw new ApiError('conflict', 'the task is running: it keeps its lane until its next start');
  const set: TaskValues = {};
  if (place !== undefined) {
    if (current.status === 'running' || current.status === 'waiting')
      throw new ApiError('conflict', `the task is ${current.status}: stop it first, then move it`);
    if (place === null) Object.assign(set, placement(null, null));
    else {
      const found = await directoryIn(tx, current.projectId, place.directoryId);
      if (place.machine !== undefined && place.machine !== found.machineId)
        throw new ApiError('bad-request', 'the directory lives on another machine');
      Object.assign(set, placement(found.machineId, place.directoryId));
    }
  }
  if (model !== undefined) set.model = model;
  if (effort !== undefined) set.effort = effort;
  if (lane !== undefined) set.requestedLane = lane;
  if (autoDone !== undefined) set.autoDone = autoDone;
  if (icon !== undefined) set.icon = icon;
  if (labels !== undefined) set.labels = labels;
  if (title !== undefined) set.title = title;
  const priorityChanged = priority !== undefined && priority !== current.priority;
  if (priorityChanged) {
    await recordServerEvent(
      tx,
      id,
      { type: 'priority', from: current.priority, to: priority },
      actor.by,
    );
    set.priority = priority;
  }
  return transitionTask(tx, current, {
    place: priorityChanged ? 'bottom' : undefined,
    by: 'user',
    set,
  });
};

export const setTaskProject = async (
  tx: ScopedDatabase,
  id: string,
  target: { projectId: string; directoryId: string | null },
): Promise<TaskRow> => {
  const current = await lockTask(tx, id);
  if (current.status === 'running' || current.status === 'waiting')
    throw new ApiError('conflict', `the task is ${current.status}: stop it first, then move it`);
  if (current.scheduleId !== null)
    throw new ApiError('conflict', 'a scheduled occurrence stays in the project of its schedule');
  const [destination] = await tx
    .select({ id: project.id, archivedAt: project.archivedAt })
    .from(project)
    .where(eq(project.id, target.projectId));
  if (!destination) throw new ApiError('not-found', 'no such project');
  if (destination.archivedAt !== null) throw new ApiError('conflict', 'the project is archived');
  const machine =
    target.directoryId === null
      ? null
      : (await directoryIn(tx, target.projectId, target.directoryId)).machineId;
  return transitionTask(tx, current, {
    by: 'user',
    set: {
      ...placement(machine, target.directoryId),
      projectId: target.projectId,
      position: await edgePosition(tx, target.projectId, current.status, 'bottom'),
    },
  });
};
