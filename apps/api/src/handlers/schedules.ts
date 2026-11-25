import type { ScopedDatabase } from '../modules/database/index.js';
import { announceTaskChange } from '../modules/events/index.js';
import type { HandlerSet } from '../http/handler.js';
import {
  addSchedule,
  editSchedule,
  listSchedules,
  removeSchedule,
  setPaused,
  toWireSchedule,
  updateSchedule,
  type ScheduleView,
} from '../modules/scheduling/index.js';
import { presentWireTasks } from '../modules/tasks/index.js';

export const scheduleHandlers: HandlerSet = (context) => {
  const { database, events } = context.services;
  const write = async <T>(
    owner: string,
    work: (tx: ScopedDatabase) => Promise<{ projectId: string; result: T }>,
  ): Promise<T> => {
    const { projectId, result } = await database.withOwner(owner, work);
    await announceTaskChange(events, owner, projectId);
    return result;
  };
  const paused = (tx: ScopedDatabase, input: { id: string; paused: boolean }) =>
    setPaused(tx, input.id, input.paused).then((view: ScheduleView) => ({
      projectId: view.projectId,
      result: toWireSchedule(view),
    }));
  return {
    'machine.add-schedule': ({ input, principal }) =>
      write(principal.owner, async (tx) => {
        const added = await addSchedule(tx, input);
        const [wire] = added.task === null ? [] : await presentWireTasks(tx, [added.task]);
        return {
          projectId: added.schedule.projectId,
          result: { schedule: toWireSchedule(added.schedule), task: wire ?? null },
        };
      }),

    'machine.list-schedules': ({ principal }) =>
      database.withOwner(principal.owner, async (tx) => ({
        schedules: (await listSchedules(tx)).map(toWireSchedule),
      })),

    'machine.update-schedule': ({ input, principal }) =>
      write(principal.owner, (tx) => paused(tx, input)),

    'machine.edit-schedule': ({ input, principal }) =>
      write(principal.owner, async (tx) => {
        const { id, title, input: prompt, settings } = input;
        const edited =
          settings === undefined
            ? await editSchedule(tx, { id, title, input: prompt })
            : await updateSchedule(tx, { id, title, input: prompt, ...settings });
        return {
          projectId: edited.schedule.projectId,
          result: { schedule: toWireSchedule(edited.schedule), pending: edited.pending },
        };
      }),

    'machine.remove-schedule': ({ input, principal }) =>
      write(principal.owner, async (tx) => ({
        projectId: await removeSchedule(tx, input.id),
        result: {},
      })),

    'client.schedules.list': ({ input, principal }) =>
      database.withOwner(principal.owner, async (tx) => ({
        schedules: (await listSchedules(tx, { projectId: input.project })).map(toWireSchedule),
      })),

    'client.schedules.set-paused': ({ input, principal }) =>
      write(principal.owner, (tx) => paused(tx, input)),

    'client.schedules.update': ({ input, principal }) =>
      write(principal.owner, async (tx) => {
        const updated = await updateSchedule(tx, input);
        return {
          projectId: updated.schedule.projectId,
          result: { schedule: toWireSchedule(updated.schedule), pending: updated.pending },
        };
      }),

    'client.schedules.remove': ({ input, principal }) =>
      write(principal.owner, async (tx) => ({
        projectId: await removeSchedule(tx, input.id),
        result: {},
      })),
  };
};
