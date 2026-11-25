import { rerunRoute, setClosedRoute, takeBackRoute } from '@agent-board/contract';

import type { Context } from '../context.js';
import { confirm, resolveTask, session, taskLink } from '../tasks/support.js';
import { asOwner, userCommand } from './support.js';

export async function runTakeBack(ctx: Context, input: string): Promise<void> {
  userCommand(ctx, 'take-back');
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  await asOwner(s, id, () => s.command(takeBackRoute, { id }));
  confirm(ctx, `took back ${id}  ${taskLink(s, id)}`);
}

export async function runRerun(ctx: Context, input: string): Promise<void> {
  userCommand(ctx, 'rerun');
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  await asOwner(s, id, () => s.command(rerunRoute, { id }));
  confirm(ctx, `queued ${id} for a fresh run  ${taskLink(s, id)}`);
}

export async function runClose(ctx: Context, input: string, closed: boolean): Promise<void> {
  userCommand(ctx, closed ? 'close' : 'reopen');
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  await asOwner(s, id, () => s.command(setClosedRoute, { id, closed }));
  confirm(ctx, `${closed ? 'closed' : 'reopened'} ${id}  ${taskLink(s, id)}`);
}
