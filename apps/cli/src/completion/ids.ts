import { listSchedulesRoute, listTasksRoute } from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import { openSession, withoutInputs } from '../transport/session.js';

export const COMPLETION_KINDS = ['tasks', 'schedules'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];
export const COMPLETION_BUDGET_MS = 2_000;

async function fetchIds(ctx: Context, kind: CompletionKind): Promise<string[]> {
  const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
  if (kind === 'tasks') {
    const { tasks } = await s.query(listTasksRoute, { all: true, ...withoutInputs(s) });
    return tasks.map((task) => task.id);
  }
  const { schedules } = await s.query(listSchedulesRoute, {});
  return schedules.map((schedule) => schedule.id);
}

export async function completeIds(
  ctx: Context,
  kind: CompletionKind,
  budgetMs = COMPLETION_BUDGET_MS,
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => {
      resolve([]);
    }, budgetMs);
  });
  try {
    return await Promise.race([fetchIds(ctx, kind).catch((): string[] => []), expired]);
  } finally {
    clearTimeout(timer);
  }
}
