import { and, eq } from 'drizzle-orm';

import { directory, project, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';
import { edgePosition } from './positions.js';
import { getTask } from './queries.js';
import type { NewTask, NewTaskExtras, TaskRow } from './types.js';

const DEFAULT_PRIORITY = 'normal';

export const resolveProject = async (
  tx: ScopedDatabase,
  projectId: string | undefined,
  allowArchived = false,
): Promise<string> => {
  const [row] = await tx
    .select({ id: project.id, archivedAt: project.archivedAt })
    .from(project)
    .where(projectId === undefined ? eq(project.isDefault, true) : eq(project.id, projectId));
  if (!row) throw new ApiError('not-found', 'no such project');
  if (!allowArchived && row.archivedAt !== null)
    throw new ApiError('conflict', 'the project is archived');
  return row.id;
};

const resolveMachine = async (
  tx: ScopedDatabase,
  projectId: string,
  draft: NewTask,
): Promise<string | null> => {
  if (draft.directoryId === undefined || draft.directoryId === null) return draft.machine ?? null;
  const [row] = await tx
    .select({ machineId: directory.machineId })
    .from(directory)
    .where(and(eq(directory.id, draft.directoryId), eq(directory.projectId, projectId)));
  if (!row) throw new ApiError('not-found', 'no such directory in the project');
  if (draft.machine !== undefined && draft.machine !== row.machineId)
    throw new ApiError('bad-request', 'the directory lives on another machine');
  return row.machineId;
};

export const createTask = async (
  tx: ScopedDatabase,
  draft: NewTask,
  extras: NewTaskExtras = {},
): Promise<{ task: TaskRow; created: boolean }> => {
  const parent = draft.parentId === undefined ? undefined : await getTask(tx, draft.parentId);
  const proposed = draft.createdBy === 'agent';
  const status = proposed ? 'backlog' : (draft.status ?? 'todo');
  if (draft.notBefore !== undefined && status !== 'todo')
    throw new ApiError('bad-request', 'only a task in todo can have a start time');
  const projectId = await resolveProject(tx, draft.projectId, extras.scheduleId !== undefined);
  const placed = await resolveMachine(tx, projectId, draft);
  const machine = proposed ? null : placed;
  const [row] = await tx
    .insert(task)
    .values({
      id: draft.id,
      title: draft.title,
      input: draft.input,
      status,
      priority: draft.priority ?? parent?.priority ?? DEFAULT_PRIORITY,
      model: draft.model ?? null,
      effort: draft.effort ?? null,
      requestedLane: draft.lane ?? null,
      autoDone: draft.autoDone ?? false,
      position: await edgePosition(tx, projectId, status, extras.place ?? 'bottom'),
      machine,
      projectId,
      directoryId: draft.directoryId ?? null,
      legacyDirectory: draft.legacyDirectory ?? null,
      legacyHomeWorkdir: draft.legacyDirectory ?? null,
      agent: draft.agent ?? null,
      icon: draft.icon ?? null,
      labels: draft.labels ?? null,
      head: draft.head ?? null,
      notBefore: draft.notBefore ?? null,
      dedupeKey: draft.dedupeKey ?? null,
      parentId: draft.parentId ?? null,
      createdBy: draft.createdBy ?? 'user',
      scheduleId: extras.scheduleId ?? null,
      forkOf: extras.forkOf ?? null,
      proposed,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { task: row, created: true };
  const [existing] =
    draft.dedupeKey === undefined
      ? []
      : await tx.select().from(task).where(eq(task.dedupeKey, draft.dedupeKey));
  if (!existing) throw new ApiError('conflict', 'that task id is already taken');
  return { task: existing, created: false };
};
