import { ackWatchStopsRoute, getTaskRoute } from '@rumo/contract';

import type { OpenTask } from '../commands/tasks/open.js';
import { publishWatches } from '../watch/publish.js';
import { WAIT_WATCH_NAME } from '../watch/shapes.js';
import { WatchStore } from '../watch/store.js';
import { WAKE_MARKER, eventText, wakeTask } from '../watch/wake.js';
import { ApiError } from '../transport/errors.js';
import { TASK_LOOKUPS_PER_TICK } from './limits.js';
import type { TickEnv } from './env.js';

type Dropped = 'done' | 'closed' | 'gone' | 'backlog';

function dropReason(task: OpenTask['wire']): Dropped | undefined {
  if (task.closed) return 'closed';
  if (task.status === 'done') return 'done';
  if (task.status === 'backlog') return 'backlog';
  return undefined;
}

export async function dropFinishedWatches(
  env: TickEnv,
  store: WatchStore,
  listed: readonly OpenTask[],
): Promise<void> {
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of store.tasks()) {
    let reason: Dropped | undefined;
    const task = shown.get(id);
    if (task !== undefined) reason = dropReason(task.wire);
    else if (lookups >= TASK_LOOKUPS_PER_TICK) continue;
    else {
      lookups += 1;
      try {
        reason = dropReason(await env.s.query(getTaskRoute, { id }));
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) continue;
        reason = 'gone';
      }
    }
    if (reason === undefined) continue;
    env.log(`DROP-WATCHES ${id} its task is ${reason}`);
    if (env.ctx.dryRun) continue;
    store.dropTask(id);
    store.removeEvents(id);
    if (reason !== 'gone') await publishWatches(env.s, store, id, env.log);
  }
}

export async function applyWatchStops(
  env: TickEnv,
  store: WatchStore,
  tasks: readonly OpenTask[],
): Promise<void> {
  for (const task of tasks) {
    if (task.wire.machine !== env.s.machine || task.wire.watchStops.length === 0) continue;
    if (env.ctx.dryRun || !env.s.supports('watches')) continue;
    const stops = new Set(task.wire.watchStops);
    for (const def of store.list(task.id).defs) {
      if (stops.has(def.id)) store.claim(task.id, def.name, def.id)?.done();
    }
    await publishWatches(env.s, store, task.id, env.log);
    await env.s.command(ackWatchStopsRoute, { id: task.id, ids: [...stops] });
  }
}

export async function wakeDue(
  env: TickEnv,
  store: WatchStore,
  tasks: readonly OpenTask[],
): Promise<void> {
  const now = env.now().getTime();
  for (const task of tasks) {
    if (task.wire.status !== 'waiting' || task.wire.machine !== env.s.machine) continue;
    const events = store.events(task.id);
    const { defs } = store.list(task.id);
    const due = task.wire.wakeAt === null || Date.parse(task.wire.wakeAt) <= now;
    const waitWatch = defs.find((def) => def.name === WAIT_WATCH_NAME);
    let why: string | undefined;
    if (events.length > 0) why = events.map(eventText).join('\n\n');
    else if (task.wire.waitCheck && waitWatch === undefined && defs.length === 0) {
      why = `${WAKE_MARKER} its check is no longer stored on ${env.s.machine}, so nothing could end it. Find out yourself whether what you waited for is done.`;
    } else if (due) {
      why = task.wire.waitCheck
        ? `${WAKE_MARKER} the check did not pass before its timeout.`
        : `${WAKE_MARKER} its time ran out.`;
    }
    if (why === undefined) continue;
    env.log(`WAKE ${task.id} ${why.split('\n')[0]}`);
    if (env.ctx.dryRun) continue;
    if (await wakeTask(env.s, task.id, why)) {
      store.removeEvents(task.id);
      if (waitWatch !== undefined) store.claim(task.id, WAIT_WATCH_NAME, waitWatch.id)?.done();
      await publishWatches(env.s, store, task.id, env.log);
    }
  }
}
