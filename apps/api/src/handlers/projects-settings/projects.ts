import { MAX_PROJECT_POSITION, type WireProject } from '@rumo/contract';
import { and, asc, count, eq, max, sql } from 'drizzle-orm';

import type { ServerContext } from '../../context.js';
import { directory, project, schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { HandlerTable } from '../../http/handler.js';
import type { ScopedDatabase } from '../../modules/database/index.js';
import { announceChange } from '../../modules/events/index.js';
import { isForeignKeyViolation } from './database-errors.js';

type ProjectRow = typeof project.$inferSelect;

const wire = (row: ProjectRow): WireProject => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  position: row.position,
  isDefault: row.isDefault,
  archivedAt: row.archivedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const listProjects = async (tx: ScopedDatabase): Promise<{ projects: WireProject[] }> => ({
  projects: (
    await tx
      .select()
      .from(project)
      .orderBy(asc(project.position), asc(project.createdAt), asc(project.id))
  ).map(wire),
});

const load = async (tx: ScopedDatabase, id: string): Promise<ProjectRow> => {
  const [row] = await tx.select().from(project).where(eq(project.id, id));
  if (row === undefined) throw new ApiError('not-found', 'no such project');
  return row;
};

const defaultProject = async (tx: ScopedDatabase): Promise<ProjectRow> => {
  const [row] = await tx.select().from(project).where(eq(project.isDefault, true));
  if (row === undefined) throw new ApiError('internal', 'the owner has no default project');
  return row;
};

const countIn = async (tx: ScopedDatabase, projectId: string) => {
  const of = async (table: typeof task | typeof schedule | typeof directory) => {
    const [row] = await tx
      .select({ total: count() })
      .from(table)
      .where(eq(table.projectId, projectId));
    return row?.total ?? 0;
  };
  await tx.select({ id: task.id }).from(task).where(eq(task.projectId, projectId)).for('update');
  const [running] = await tx
    .select({ total: count() })
    .from(task)
    .where(and(eq(task.projectId, projectId), eq(task.status, 'running')));
  return {
    tasks: await of(task),
    schedules: await of(schedule),
    directories: await of(directory),
    running: running?.total ?? 0,
  };
};

export const projectHandlers = (context: ServerContext): HandlerTable => {
  const { database, events } = context.services;
  const write = async <T>(
    owner: string,
    projectId: string,
    work: (tx: ScopedDatabase) => Promise<T>,
  ): Promise<T> => {
    const result = await database.withOwner(owner, work);
    await announceChange(events, owner, projectId);
    return result;
  };

  return {
    'client.projects.list': ({ principal }) =>
      database.withOwner(principal.owner, (tx) => listProjects(tx)),

    'machine.list-projects': ({ principal }) =>
      database.withOwner(principal.owner, (tx) => listProjects(tx)),

    'client.projects.create': ({ input, principal }) =>
      write(principal.owner, input.id, async (tx) => {
        const [top] = await tx.select({ top: max(project.position) }).from(project);
        const position = input.position ?? Math.min((top?.top ?? -1) + 1, MAX_PROJECT_POSITION);
        const created = await tx
          .insert(project)
          .values({ id: input.id, name: input.name, icon: input.icon, position })
          .onConflictDoNothing()
          .returning({ id: project.id });
        if (created.length === 0) throw new ApiError('conflict', 'that project id is taken');
        return {};
      }),

    'client.projects.update': ({ input, principal }) =>
      write(principal.owner, input.id, async (tx) => {
        await load(tx, input.id);
        await tx
          .update(project)
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.icon !== undefined && { icon: input.icon }),
            ...(input.position !== undefined && { position: input.position }),
            updatedAt: new Date(),
          })
          .where(eq(project.id, input.id));
        return {};
      }),

    'client.projects.archive': ({ input, principal }) =>
      write(principal.owner, input.id, async (tx) => {
        const target = await load(tx, input.id);
        if (target.isDefault)
          throw new ApiError('forbidden', 'the default project cannot be archived');
        await tx
          .update(project)
          .set({ archivedAt: target.archivedAt ?? new Date(), updatedAt: new Date() })
          .where(eq(project.id, input.id));
        return {};
      }),

    'client.projects.unarchive': ({ input, principal }) =>
      write(principal.owner, input.id, async (tx) => {
        await load(tx, input.id);
        await tx
          .update(project)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(eq(project.id, input.id));
        return {};
      }),

    'client.projects.delete': ({ input, principal }) =>
      write(principal.owner, input.id, async (tx) => {
        const target = await load(tx, input.id);
        if (target.isDefault)
          throw new ApiError('forbidden', 'the default project cannot be deleted');
        const used = await countIn(tx, target.id);
        const occupied = used.tasks + used.schedules + used.directories > 0;
        if (occupied && input.then === undefined)
          throw new ApiError(
            'conflict',
            'the project still has tasks, schedules or directories: say then move-to-default or delete',
          );
        if (occupied && used.running > 0)
          throw new ApiError('conflict', 'a task of this project is running');
        try {
          await tx.transaction(async (step) => {
            if (occupied && input.then === 'move-to-default') {
              const moved = { projectId: (await defaultProject(step)).id };
              await step.update(directory).set(moved).where(eq(directory.projectId, target.id));
              await step
                .update(task)
                .set({ ...moved, updatedAt: sql`now()` })
                .where(eq(task.projectId, target.id));
              await step.update(schedule).set(moved).where(eq(schedule.projectId, target.id));
            }
            if (occupied && input.then === 'delete') {
              await step.delete(task).where(eq(task.projectId, target.id));
              await step.delete(schedule).where(eq(schedule.projectId, target.id));
              await step.delete(directory).where(eq(directory.projectId, target.id));
            }
            await step.delete(project).where(eq(project.id, target.id));
          });
        } catch (error) {
          if (isForeignKeyViolation(error))
            throw new ApiError('conflict', 'another project has schedules chained after this one');
          throw error;
        }
        return {};
      }),
  };
};
