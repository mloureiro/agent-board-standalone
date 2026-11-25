import { and, count, eq } from 'drizzle-orm';

import type { ServerContext } from '../../context.js';
import { directory, machine, project, schedule, task } from '../../db/schema/index.js';
import { ApiError } from '../../errors.js';
import type { HandlerTable } from '../../http/handler.js';

export const directoryHandlers = (context: ServerContext): HandlerTable => {
  const { database } = context.services;

  return {
    'client.directories.list': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        if (input.project !== undefined) {
          const [known] = await tx
            .select({ id: project.id })
            .from(project)
            .where(eq(project.id, input.project));
          if (known === undefined) throw new ApiError('not-found', 'no such project');
        }
        if (input.machine !== undefined) {
          const [known] = await tx
            .select({ id: machine.id })
            .from(machine)
            .where(eq(machine.id, input.machine));
          if (known === undefined) throw new ApiError('not-found', 'no such machine');
        }
        const rows = await tx
          .select()
          .from(directory)
          .where(
            and(
              input.project === undefined ? undefined : eq(directory.projectId, input.project),
              input.machine === undefined ? undefined : eq(directory.machineId, input.machine),
            ),
          )
          .orderBy(directory.createdAt, directory.id);
        return {
          directories: rows.map((row) => ({
            id: row.id,
            path: row.path,
            repo: row.repo,
            projectId: row.projectId,
          })),
        };
      }),

    'client.directories.move': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => {
        const [moving] = await tx.select().from(directory).where(eq(directory.id, input.id));
        if (moving === undefined) throw new ApiError('not-found', 'no such directory');
        const [destination] = await tx
          .select({ id: project.id })
          .from(project)
          .where(eq(project.id, input.projectId));
        if (destination === undefined) throw new ApiError('not-found', 'no such project');
        if (moving.projectId === input.projectId) return {};

        const [tasks] = await tx
          .select({ total: count() })
          .from(task)
          .where(eq(task.directoryId, moving.id));
        const [schedules] = await tx
          .select({ total: count() })
          .from(schedule)
          .where(eq(schedule.directoryId, moving.id));
        const [running] = await tx
          .select({ total: count() })
          .from(task)
          .where(and(eq(task.directoryId, moving.id), eq(task.status, 'running')));
        if ((tasks?.total ?? 0) + (schedules?.total ?? 0) > 0 && input.withUsers !== true)
          throw new ApiError('directory-in-use', 'tasks or schedules use this directory');
        if ((running?.total ?? 0) > 0)
          throw new ApiError('conflict', 'a task using this directory is running');

        await tx
          .update(directory)
          .set({ projectId: input.projectId })
          .where(eq(directory.id, moving.id));
        await tx
          .update(task)
          .set({ projectId: input.projectId })
          .where(eq(task.directoryId, moving.id));
        await tx
          .update(schedule)
          .set({ projectId: input.projectId })
          .where(eq(schedule.directoryId, moving.id));
        return {};
      }),
  };
};
