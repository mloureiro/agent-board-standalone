import {
  TASK_ACTORS,
  getTaskRoute,
  listTasksRoute,
  readNotesRoute,
  machineName,
  type TaskActor,
} from '@rumo/contract';

import { ReportedFailure, UsageError } from '../../errors.js';
import { parseStatus } from '../../domain/rules.js';
import { EVENT_TYPES, type EventFilter, type EventType } from '../../events/diff.js';
import { eventJson, eventLine } from '../../events/format.js';
import { runEvents, type EventsTiming } from '../../events/run.js';
import { ApiError } from '../../transport/errors.js';
import type { Context } from '../context.js';
import { checkedProject } from './list.js';
import { openNote, openTask } from './open.js';
import { refuseInRun, resolveTask, session, taskLink } from './support.js';

export interface EventsOptions {
  readonly task?: readonly string[];
  readonly status?: readonly string[];
  readonly type?: readonly string[];
  readonly actor?: readonly string[];
  readonly machine?: string;
  readonly project?: string;
  readonly json?: boolean;
}

function parseType(name: string): EventType {
  const found = EVENT_TYPES.find((type) => type === name.trim().toLowerCase());
  if (found === undefined) {
    throw new UsageError(
      `unknown event type "${name.slice(0, 40)}"; use one of ${EVENT_TYPES.join(', ')}`,
    );
  }
  return found;
}

function parseActor(name: string): TaskActor {
  const found = TASK_ACTORS.find((actor) => actor === name.trim().toLowerCase());
  if (found === undefined) {
    throw new UsageError(
      `unknown actor "${name.slice(0, 40)}"; use one of ${TASK_ACTORS.join(', ')}`,
    );
  }
  return found;
}

export async function runEventsCommand(
  ctx: Context,
  options: EventsOptions,
  timing?: Partial<EventsTiming>,
): Promise<void> {
  refuseInRun(ctx, 'rumo events');
  if (options.machine !== undefined && !machineName.safeParse(options.machine).success) {
    throw new UsageError(`"${options.machine.slice(0, 40)}" is not a valid machine name`);
  }
  const project = options.project === undefined ? undefined : checkedProject(options.project);
  const statuses = (options.status ?? []).map(parseStatus);
  const types = (options.type ?? []).map(parseType);
  const actors = (options.actor ?? []).map(parseActor);
  const s = await session(ctx);
  if (project !== undefined) s.require('projects');
  const tasks = await Promise.all((options.task ?? []).map((input) => resolveTask(ctx, s, input)));
  const filter: EventFilter = {
    tasks,
    statuses,
    types,
    actors,
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(project === undefined ? {} : { project }),
  };
  const code = await runEvents({
    openStream: (signal) => s.openEvents('/api/machine/events', signal),
    list: async () => {
      const { tasks: listed } = await s.query(listTasksRoute, {});
      return Promise.all(listed.map((task) => openTask(s.keys, task)));
    },
    readNotes: async (id) => {
      const { notes } = await s.query(readNotesRoute, { id });
      return Promise.all(notes.map((note) => openNote(s.keys, id, note)));
    },
    fetchLeft: async (id) => {
      try {
        return await openTask(s.keys, await s.query(getTaskRoute, { id }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    filter,
    emit: (event) => {
      ctx.out(
        options.json === true
          ? JSON.stringify(eventJson(event, (id) => taskLink(s, id)))
          : eventLine(event),
      );
    },
    log: (line) => {
      ctx.err(`rumo events: ${line}`);
    },
    now: () => new Date(),
    signal: ctx.rt.interrupt,
    ...(timing === undefined ? {} : { timing }),
  });
  if (code !== 0) throw new ReportedFailure(code);
}
