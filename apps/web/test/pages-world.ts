import {
  listClientSchedulesRoute,
  listClientTasksRoute,
  removeClientScheduleRoute,
  setPausedClientScheduleRoute,
  updateClientScheduleRoute,
  type WireSchedule,
} from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { OWNER_KEYS, hours, isoAt } from './board-world.js';
import { json } from './fake-board.js';
import { PROJECT_HOME, TaskWorld } from './task-world.js';

export interface SeedSchedule {
  readonly id: string;
  readonly title: string;
  readonly prompt?: string;
  readonly everyMs?: number;
  readonly projectId?: string;
  readonly paused?: boolean;
}

export class PagesWorld extends TaskWorld {
  schedules: WireSchedule[] = [];
  readonly writes: { path: string; body: Record<string, unknown> }[] = [];

  async seedSchedule(input: SeedSchedule): Promise<WireSchedule> {
    const keys = await OWNER_KEYS;
    const schedule: WireSchedule = {
      id: input.id,
      title: await seal(keys, bindings.title({ schedule: input.id }), input.title),
      input: await seal(
        keys,
        bindings.input({ origin: { schedule: input.id }, creator: 'user' }),
        input.prompt ?? `prompt of ${input.title}`,
      ),
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      machine: null,
      projectId: input.projectId ?? PROJECT_HOME,
      directoryId: null,
      legacyDirectory: null,
      everyMs: input.everyMs ?? 3_600_000,
      cron: null,
      timezone: null,
      after: null,
      maxConcurrent: null,
      anchorAt: isoAt(-hours(5)),
      nextRunAt: isoAt(hours(1)),
      remaining: null,
      until: null,
      paused: input.paused ?? false,
      ended: false,
      occurrenceTaskId: null,
      createdAt: isoAt(-hours(5)),
    };
    this.schedules.push(schedule);
    return schedule;
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    const query = new URL(this.current.pathWithQuery, 'http://localhost').searchParams;
    if (method === 'GET' && path === listClientSchedulesRoute.path) {
      const project = query.get('project');
      return json(200, {
        schedules: this.schedules.filter((s) => project === null || s.projectId === project),
      });
    }
    if (method === 'GET' && path === listClientTasksRoute.path) {
      const closed = query.get('closed') === 'true';
      return json(200, { tasks: this.tasks.filter((task) => task.closed === closed) });
    }
    if (method === 'POST' && path === setPausedClientScheduleRoute.path) {
      this.writes.push({ path, body: body ?? {} });
      const found = this.schedules.find((s) => s.id === body?.id);
      if (found === undefined) return json(404, { error: { code: 'not-found', message: 'no' } });
      found.paused = body?.paused === true;
      return json(200, found);
    }
    if (method === 'POST' && path === removeClientScheduleRoute.path) {
      this.writes.push({ path, body: body ?? {} });
      this.schedules = this.schedules.filter((s) => s.id !== body?.id);
      return json(200, {});
    }
    if (method === 'POST' && path === updateClientScheduleRoute.path) {
      this.writes.push({ path, body: body ?? {} });
      const found = this.schedules.find((s) => s.id === body?.id);
      if (found === undefined) return json(404, { error: { code: 'not-found', message: 'no' } });
      found.title = String(body?.title);
      found.input = String(body?.input);
      found.priority = body?.priority as WireSchedule['priority'];
      found.autoDone = body?.autoDone === true;
      const repeat = body?.repeat as { everyMs?: number } | undefined;
      if (repeat?.everyMs !== undefined) found.everyMs = repeat.everyMs;
      return json(200, { schedule: found, pending: 'updated' });
    }
    return super.answer(method, path, body);
  }
}
