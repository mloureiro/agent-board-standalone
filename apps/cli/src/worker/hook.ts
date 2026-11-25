import path from 'node:path';

import { taskId } from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import { createRunRecords } from '../dispatch/run-record.js';
import { isRecord } from '../domain/values.js';
import { now as clockNow } from '../transport/clock.js';
import { createWorktreeLocks } from './worktree-locks.js';

export interface HookInput {
  readonly cwd: string | null;
}

export function parseHookInput(text: string): HookInput {
  try {
    const parsed: unknown = JSON.parse(text);
    const cwd = isRecord(parsed) ? parsed.cwd : undefined;
    return { cwd: typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : null };
  } catch {
    return { cwd: null };
  }
}

function forThisRun(ctx: Context, dir: string, task: string): boolean {
  if (!ctx.inRun) return true;
  return ctx.runTask === task && path.resolve(ctx.dirs.run) === path.resolve(dir);
}

export async function runHook(ctx: Context, args: readonly string[]): Promise<void> {
  try {
    const [dir, task] = args;
    if (dir === undefined || task === undefined)
      throw new Error('usage: internal hook <run dir> <task>');
    if (!path.isAbsolute(dir) || !taskId.safeParse(task).success) {
      throw new Error('the run directory must be absolute and the task id valid');
    }
    if (!forThisRun(ctx, dir, task)) return;
    const records = createRunRecords(dir);
    records.touchActive(task, new Date(clockNow(ctx.rt.env)));
    const { cwd } = parseHookInput(await ctx.rt.readStdin());
    if (cwd === null) return;
    if (records.lastCwd(task) !== cwd) {
      await createWorktreeLocks(ctx.dirs.state, ctx.rt.exec).hold(task, cwd);
    }
    records.writeCwd(task, cwd);
  } catch (error) {
    ctx.err(`board internal hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
