import { getTaskRoute } from '@agent-board/contract';

import type { OpenTask } from '../commands/tasks/open.js';
import { ApiError } from '../transport/errors.js';
import { createWorktreeLocks } from '../worker/worktree-locks.js';
import type { TickEnv } from './env.js';
import { TASK_LOOKUPS_PER_TICK } from './limits.js';

async function isFinished(s: TickEnv['s'], id: string): Promise<boolean> {
  try {
    const task = await s.query(getTaskRoute, { id });
    return task.closed || task.status === 'done';
  } catch (error) {
    return error instanceof ApiError && error.status === 404;
  }
}

export async function releaseFinishedWorktrees(
  env: TickEnv,
  listed: readonly OpenTask[],
  active: readonly string[],
): Promise<void> {
  const locks = createWorktreeLocks(env.ctx.dirs.state, env.ctx.rt.exec);
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of locks.tasks()) {
    if (active.includes(id)) continue;
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    const finished =
      task === undefined
        ? await isFinished(env.s, id)
        : task.wire.status === 'done' || task.wire.closed;
    if (!finished) continue;
    env.log(`UNLOCK ${id} its task is finished`);
    if (env.ctx.dryRun) continue;
    for (const line of await locks.release(id)) env.log(line);
  }
}
