import { getTaskRoute, listTasksRoute } from '@agent-board/contract';

import { UsageError } from '../../errors.js';
import { openSession, withoutInputs, type Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { resolveTaskId } from '../ids.js';
import { openTask, type OpenTask } from './open.js';

export function session(ctx: Context): Promise<Session> {
  return openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun });
}

export function taskLink(s: Session, id: string): string {
  return `${s.url.replace(/\/+$/, '')}/t/${id}`;
}

export function resolveTask(ctx: Context, s: Session, input: string): Promise<string> {
  return resolveTaskId(input, {
    inRun: ctx.inRun,
    serverUrl: s.url,
    listIds: async () => {
      const { tasks } = await s.query(listTasksRoute, { all: true, ...withoutInputs(s) });
      return tasks.map((task) => task.id);
    },
  });
}

export async function fetchTask(s: Session, id: string): Promise<OpenTask> {
  return openTask(s.keys, await s.query(getTaskRoute, { id }));
}

export function confirm(ctx: Context, line: string): void {
  if (!ctx.dryRun) ctx.out(line);
}

export function refuseInRun(ctx: Context, what: string): void {
  if (ctx.inRun) throw new UsageError(`${what} is not available inside a board run`);
}

export function fenceOf(ctx: Context, id: string): { run?: string } {
  return ctx.runId !== null && ctx.runTask === id ? { run: ctx.runId } : {};
}

export function newTaskId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}
