import type { DirectoryInput, WireDirectory } from '@rumo/contract';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

import { directory, legacyDirs, project, schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { ScopedDatabase } from '../database/index.js';

export interface LegacyDirectoryUse {
  kind: 'task' | 'schedule';
  id: string;
  legacyDirectory: string;
}

export interface LegacyDirsAnswer {
  document: string | null;
  tasks: LegacyDirectoryUse[];
}

export interface DirectoryAssignment {
  kind: 'task' | 'schedule';
  id: string;
  directoryId: string;
}

export const hasLegacyDirs = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
): Promise<boolean> =>
  (
    await tx
      .select({ machineId: legacyDirs.machineId })
      .from(legacyDirs)
      .where(and(eq(legacyDirs.owner, owner), eq(legacyDirs.machineId, machineId)))
  ).length > 0;

export const getLegacyDirs = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
): Promise<LegacyDirsAnswer> => {
  const [stored] = await tx
    .select({ document: legacyDirs.document })
    .from(legacyDirs)
    .where(and(eq(legacyDirs.owner, owner), eq(legacyDirs.machineId, machineId)));
  const tasks = await tx
    .select({ id: task.id, legacyDirectory: task.legacyDirectory })
    .from(task)
    .where(
      and(
        eq(task.owner, owner),
        isNull(task.directoryId),
        isNotNull(task.legacyDirectory),
        or(isNull(task.machine), eq(task.machine, machineId)),
      ),
    )
    .orderBy(asc(task.id));
  const schedules = await tx
    .select({ id: schedule.id, legacyDirectory: schedule.legacyDirectory })
    .from(schedule)
    .where(
      and(
        eq(schedule.owner, owner),
        isNull(schedule.directoryId),
        isNotNull(schedule.legacyDirectory),
        or(isNull(schedule.machine), eq(schedule.machine, machineId)),
      ),
    )
    .orderBy(asc(schedule.id));
  return {
    document: stored?.document ?? null,
    tasks: [
      ...tasks.map((row) => ({
        kind: 'task' as const,
        id: row.id,
        legacyDirectory: row.legacyDirectory ?? '',
      })),
      ...schedules.map((row) => ({
        kind: 'schedule' as const,
        id: row.id,
        legacyDirectory: row.legacyDirectory ?? '',
      })),
    ],
  };
};

const defaultProjectOf = async (tx: ScopedDatabase, owner: string): Promise<string> => {
  const [stored] = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.owner, owner), eq(project.isDefault, true)));
  if (stored === undefined) throw new ApiError('not-found', 'the account has no default project');
  return stored.id;
};

const requireProject = async (
  tx: ScopedDatabase,
  owner: string,
  projectId: string,
): Promise<void> => {
  const found = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.owner, owner), eq(project.id, projectId)));
  if (found.length === 0) throw new ApiError('not-found', `project ${projectId} does not exist`);
};

const usersOf = async (
  tx: ScopedDatabase,
  owner: string,
  directoryIds: readonly string[],
): Promise<Set<string>> => {
  if (directoryIds.length === 0) return new Set();
  const ids = [...directoryIds];
  const byTask = await tx
    .select({ id: task.directoryId })
    .from(task)
    .where(and(eq(task.owner, owner), inArray(task.directoryId, ids)));
  const bySchedule = await tx
    .select({ id: schedule.directoryId })
    .from(schedule)
    .where(and(eq(schedule.owner, owner), inArray(schedule.directoryId, ids)));
  return new Set([...byTask, ...bySchedule].map((row) => row.id as string));
};

export interface ConversionAnswer {
  inserted: number;
  assigned: number;
}

const insertDirectories = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
  directories: readonly DirectoryInput[],
  fallbackProject: string,
): Promise<number> => {
  let inserted = 0;
  for (const input of directories) {
    if (input.projectId !== undefined) await requireProject(tx, owner, input.projectId);
    const written = await tx
      .insert(directory)
      .values({
        owner,
        id: input.id,
        machineId,
        projectId: input.projectId ?? fallbackProject,
        path: input.path,
        repo: input.repo,
      })
      .onConflictDoNothing({ target: [directory.owner, directory.id] })
      .returning({ id: directory.id });
    inserted += written.length;
  }
  return inserted;
};

const assignTo = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
  kind: 'task' | 'schedule',
  directoryId: string,
  projectId: string,
  ids: readonly string[],
): Promise<number> => {
  if (kind === 'task') {
    const changed = await tx
      .update(task)
      .set({ directoryId, legacyDirectory: null })
      .where(
        and(
          eq(task.owner, owner),
          inArray(task.id, [...ids]),
          isNull(task.directoryId),
          isNotNull(task.legacyDirectory),
          eq(task.projectId, projectId),
          or(isNull(task.machine), eq(task.machine, machineId)),
        ),
      )
      .returning({ id: task.id });
    return changed.length;
  }
  const changed = await tx
    .update(schedule)
    .set({ directoryId, legacyDirectory: null })
    .where(
      and(
        eq(schedule.owner, owner),
        inArray(schedule.id, [...ids]),
        isNull(schedule.directoryId),
        isNotNull(schedule.legacyDirectory),
        eq(schedule.projectId, projectId),
        or(isNull(schedule.machine), eq(schedule.machine, machineId)),
      ),
    )
    .returning({ id: schedule.id });
  return changed.length;
};

export const convertLegacyDirs = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
  input: { directories: readonly DirectoryInput[]; assign: readonly DirectoryAssignment[] },
): Promise<ConversionAnswer> => {
  const fallbackProject = await defaultProjectOf(tx, owner);
  const inserted = await insertDirectories(
    tx,
    owner,
    machineId,
    input.directories,
    fallbackProject,
  );

  const wanted = [...new Set(input.assign.map((pair) => pair.directoryId))];
  const stored =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: directory.id, projectId: directory.projectId })
          .from(directory)
          .where(and(eq(directory.owner, owner), inArray(directory.id, wanted)));
  const projectOf = new Map(stored.map((row) => [row.id, row.projectId]));
  const missing = wanted.find((id) => !projectOf.has(id));
  if (missing !== undefined) throw new ApiError('not-found', `directory ${missing} does not exist`);

  const groups = new Map<
    string,
    { kind: 'task' | 'schedule'; directoryId: string; ids: string[] }
  >();
  for (const pair of input.assign) {
    const key = `${pair.kind}:${pair.directoryId}`;
    const group = groups.get(key) ?? { kind: pair.kind, directoryId: pair.directoryId, ids: [] };
    group.ids.push(pair.id);
    groups.set(key, group);
  }
  let assigned = 0;
  for (const group of groups.values()) {
    assigned += await assignTo(
      tx,
      owner,
      machineId,
      group.kind,
      group.directoryId,
      projectOf.get(group.directoryId) as string,
      group.ids,
    );
  }

  await tx
    .delete(legacyDirs)
    .where(and(eq(legacyDirs.owner, owner), eq(legacyDirs.machineId, machineId)));
  return { inserted, assigned };
};

const wireOf = (row: typeof directory.$inferSelect): WireDirectory => ({
  id: row.id,
  path: row.path,
  repo: row.repo,
  projectId: row.projectId,
});

export const setDirs = async (
  tx: ScopedDatabase,
  owner: string,
  machineId: string,
  directories: readonly DirectoryInput[],
): Promise<WireDirectory[]> => {
  const fallbackProject = await defaultProjectOf(tx, owner);
  const existing = await tx
    .select()
    .from(directory)
    .where(and(eq(directory.owner, owner), eq(directory.machineId, machineId)));
  const byId = new Map(existing.map((row) => [row.id, row]));
  const kept = new Set(directories.map((input) => input.id));

  const removed = existing.filter((row) => !kept.has(row.id)).map((row) => row.id);
  const moved = directories
    .filter((input) => {
      const current = byId.get(input.id);
      return (
        current !== undefined &&
        input.projectId !== undefined &&
        input.projectId !== current.projectId
      );
    })
    .map((input) => input.id);
  for (const input of directories) {
    if (input.projectId !== undefined) await requireProject(tx, owner, input.projectId);
  }
  const inUse = await usersOf(tx, owner, [...removed, ...moved]);
  if (inUse.size > 0)
    throw new ApiError('directory-in-use', 'tasks or schedules still use a changed directory');

  if (removed.length > 0)
    await tx
      .delete(directory)
      .where(and(eq(directory.owner, owner), inArray(directory.id, removed)));
  for (const input of directories) {
    const current = byId.get(input.id);
    if (current === undefined) {
      const written = await tx
        .insert(directory)
        .values({
          owner,
          id: input.id,
          machineId,
          projectId: input.projectId ?? fallbackProject,
          path: input.path,
          repo: input.repo,
        })
        .onConflictDoNothing({ target: [directory.owner, directory.id] })
        .returning({ id: directory.id });
      if (written.length === 0)
        throw new ApiError('conflict', `directory ${input.id} belongs to another machine`);
    } else {
      await tx
        .update(directory)
        .set({
          path: input.path,
          repo: input.repo,
          projectId: input.projectId ?? current.projectId,
        })
        .where(and(eq(directory.owner, owner), eq(directory.id, input.id)));
    }
  }
  const stored = await tx
    .select()
    .from(directory)
    .where(and(eq(directory.owner, owner), eq(directory.machineId, machineId)))
    .orderBy(asc(directory.createdAt), asc(directory.id));
  return stored.map(wireOf);
};
