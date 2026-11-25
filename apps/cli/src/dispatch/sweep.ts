import { failRoute, getTaskRoute } from '@agent-board/contract';

import type { OpenTask } from '../commands/tasks/open.js';
import { sealedNote } from '../commands/tasks/notes.js';
import { ApiError } from '../transport/errors.js';
import { liveWorkerPid } from '../shutdown/index.js';
import type { TickEnv } from './env.js';
import { SPAWN_GRACE_MS, TASK_FILES_KEEP_MS, TASK_LOOKUPS_PER_TICK } from './limits.js';
import { fenced, readLogTail } from './log-tail.js';
import { decideStale } from './plan.js';
import { workerLogFile } from './spawn.js';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { logDirectory } from '../units/layout.js';

export function workerAlive(
  env: Pick<TickEnv, 'files' | 'records' | 'processes' | 'now'>,
  task: string,
): boolean {
  if (liveWorkerPid(env, task) !== null) return true;
  const record = env.records.read(task);
  const pending =
    env.files.pidOf(task, 'pid') === null &&
    record !== null &&
    env.now().getTime() - record.startedAt.getTime() < SPAWN_GRACE_MS;
  return pending;
}

export function stopWorker(env: TickEnv, task: string): void {
  const group = env.files.pidOf(task, 'pgid');
  if (group !== null) env.processes.signal(-group.id, 'SIGKILL');
  const pid = liveWorkerPid(env, task);
  if (pid !== null) env.processes.signal(pid, 'SIGTERM');
}

export async function sweepRunning(
  env: TickEnv,
  running: readonly OpenTask[],
  afterGap: boolean,
): Promise<void> {
  const { s, ctx, log } = env;
  for (const task of running) {
    const record = env.records.read(task.id);
    const decision = decideStale({
      workerAlive: workerAlive(env, task.id),
      startedAt: record?.startedAt ?? parseTime(task.wire.runStartedAt),
      lastActive: env.records.lastActive(task.id) ?? parseTime(task.wire.lastActiveAt),
      now: env.now(),
      limits: env.config,
      afterGap,
    });
    if (!decision.stale) continue;
    log(`STALE ${task.id} ${decision.reason}`);
    if (ctx.dryRun) continue;
    if (decision.stopWorker) stopWorker(env, task.id);
    env.records.clear(task.id);
    const tail = readLogTail(workerLogFile(ctx, task.id));
    const note = await sealedNote(
      s.keys,
      task.id,
      'system',
      'event',
      `${decision.reason}\n\nEnd of the log:\n${fenced(tail === '' ? '(empty)' : tail)}`,
    );
    await s.command(failRoute, {
      id: task.id,
      ...(task.wire.run === undefined ? {} : { run: task.wire.run }),
      body: note.body,
      preview: note.preview,
    });
  }
}

function parseTime(value: string | null): Date | undefined {
  return value === null ? undefined : new Date(value);
}

async function isFinished(s: TickEnv['s'], id: string): Promise<boolean> {
  try {
    const task = await s.query(getTaskRoute, { id });
    return task.closed || task.status === 'done';
  } catch (error) {
    return error instanceof ApiError && error.status === 404;
  }
}

export async function pruneTaskLogs(
  env: TickEnv,
  listed: readonly OpenTask[],
  active: readonly string[],
): Promise<void> {
  const directory = logDirectory(env.ctx.dirs);
  if (!existsSync(directory)) return;
  const cutoff = env.now().getTime() - TASK_FILES_KEEP_MS;
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.log') || name.startsWith('launchd.')) continue;
    const id = name.slice(0, -'.log'.length);
    const file = path.join(directory, name);
    if (statSync(file).mtimeMs >= cutoff || active.includes(id)) continue;
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    const finished = task === undefined ? await isFinished(env.s, id) : task.wire.status === 'done';
    if (!finished) continue;
    env.log(`DROP-LOG ${id} its task is finished`);
    if (!env.ctx.dryRun) rmSync(file, { force: true });
  }
}
