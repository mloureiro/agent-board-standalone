import { waitRoute } from '@rumo/contract';

import { UsageError } from '../../errors.js';
import {
  MAX_WAIT_MS,
  formatDuration,
  localTime,
  parseDuration,
  parseStart,
} from '../../domain/time.js';
import { ApiError } from '../../transport/errors.js';
import { WAIT_WATCH_NAME } from '../../watch/shapes.js';
import { publishWatches } from '../../watch/publish.js';
import { WatchStore, newWatchId } from '../../watch/store.js';
import type { Context } from '../context.js';
import { sealedNote } from './notes.js';
import { confirm, fenceOf, fetchTask, resolveTask, session } from './support.js';

export const DEFAULT_CHECK_EVERY = '2m';
export const DEFAULT_CHECK_TIMEOUT = '2h';
export const MIN_CHECK_EVERY_MS = 60_000;

export interface WaitOptions {
  readonly in?: string;
  readonly at?: string;
  readonly check?: string;
  readonly every?: string;
  readonly timeout?: string;
  readonly reason?: string;
}

export interface WaitPlan {
  readonly wakeAt: Date;
  readonly check?: { readonly command: string; readonly everyMs: number };
}

export function parseWaitOptions(options: WaitOptions, now: Date): WaitPlan {
  const ends = [options.in, options.at, options.check].filter((flag) => flag !== undefined);
  if (ends.length !== 1) throw new UsageError('give exactly one of --in, --at or --check');
  let plan: WaitPlan;
  if (options.check === undefined) {
    if (options.every !== undefined || options.timeout !== undefined) {
      throw new UsageError('--every and --timeout go with --check');
    }
    plan = { wakeAt: parseStart({ in: options.in, at: options.at }, now) ?? now };
  } else {
    if (options.check.trim() === '') throw new UsageError('--check needs a command');
    const everyMs = parseDuration(options.every ?? DEFAULT_CHECK_EVERY);
    if (everyMs < MIN_CHECK_EVERY_MS) throw new UsageError('--every must be at least 1m');
    plan = {
      wakeAt: new Date(now.getTime() + parseDuration(options.timeout ?? DEFAULT_CHECK_TIMEOUT)),
      check: { command: options.check, everyMs },
    };
  }
  if (plan.wakeAt.getTime() - now.getTime() > MAX_WAIT_MS) {
    throw new UsageError(`a wait may last at most ${formatDuration(MAX_WAIT_MS)}`);
  }
  return plan;
}

export function waitText(plan: WaitPlan, reason: string | undefined, machine: string): string {
  const what = reason?.trim() || (plan.check ? 'Waiting for a check.' : 'Waiting.');
  const when = plan.check
    ? `Waiting until a check on ${machine} passes (every ${formatDuration(plan.check.everyMs)}), at most until ${localTime(plan.wakeAt)}.`
    : `Waiting until ${localTime(plan.wakeAt)}.`;
  return `${what}\n\n${when}`;
}

export async function runWait(ctx: Context, input: string, options: WaitOptions): Promise<void> {
  const now = new Date();
  const plan = parseWaitOptions(options, now);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const store = new WatchStore(ctx.dirs.state);
  let stored: { id: string } | undefined;

  if (plan.check !== undefined) {
    const task = (await fetchTask(s, id)).wire;
    if (task.status !== 'running') {
      throw new UsageError(`${id} is ${task.status}: only a running task can wait`);
    }
    if (task.createdBy === 'intake') {
      throw new UsageError(
        `${id} is a task of the removed intake: it may wait with --in or --at only`,
      );
    }
    if (ctx.restricted) {
      throw new UsageError(
        `${id} runs as an agent with a fixed list of commands: it may wait with --in or --at only`,
      );
    }
    if (task.machine !== s.machine) {
      throw new UsageError(
        `${id} runs on ${task.machine ?? 'no machine'}, not on ${s.machine}: a check runs on the task's machine`,
      );
    }
    if (ctx.dryRun) {
      ctx.out(`DRY store check for ${id} in ${ctx.rt.cwd()}: ${plan.check.command}`);
    } else {
      stored = { id: newWatchId() };
      store.write({
        id: stored.id,
        name: WAIT_WATCH_NAME,
        task: id,
        source: {
          kind: 'command',
          command: plan.check.command,
          cwd: ctx.rt.cwd(),
          ...(ctx.startDir === null ? {} : { settingsDir: ctx.startDir }),
        },
        everyMs: plan.check.everyMs,
        createdAt: now.toISOString(),
        deadline: plan.wakeAt.toISOString(),
      });
    }
  }

  try {
    const note = await sealedNote(
      s.keys,
      id,
      'agent',
      'comment',
      waitText(plan, options.reason, s.machine),
    );
    await s.command(waitRoute, {
      id,
      ...fenceOf(ctx, id),
      body: note.body,
      preview: note.preview,
      wakeAt: plan.wakeAt.toISOString(),
      check: plan.check !== undefined,
    });
  } catch (error) {
    if (stored !== undefined && error instanceof ApiError && error.status < 500) {
      store.claim(id, WAIT_WATCH_NAME, stored.id)?.done();
    }
    if (error instanceof ApiError && error.status === 409) {
      throw new UsageError(`${id} cannot wait: ${error.message}`);
    }
    throw error;
  }
  if (plan.check !== undefined && !ctx.dryRun) {
    await publishWatches(s, store, id, (line) => {
      ctx.err(line);
    });
  }
  confirm(
    ctx,
    plan.check
      ? `${id} waits for its check, at most until ${localTime(plan.wakeAt)}; end your turn now`
      : `${id} waits until ${localTime(plan.wakeAt)}; end your turn now`,
  );
}
