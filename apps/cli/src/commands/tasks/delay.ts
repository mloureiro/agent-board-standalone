import { updateTaskRoute } from '@agent-board/contract';

import { UsageError } from '../../errors.js';
import { localTime, parseStart } from '../../domain/time.js';
import type { Context } from '../context.js';
import { confirm, resolveTask, session } from './support.js';

export interface DelayOptions {
  readonly in?: string;
  readonly at?: string;
  readonly now?: boolean;
}

export function parseDelay(options: DelayOptions, now: Date): Date | null {
  const given = [options.in, options.at, options.now].filter(
    (flag) => flag !== undefined && flag !== false,
  );
  if (given.length !== 1) throw new UsageError('give exactly one of --in, --at or --now');
  if (options.now === true) return null;
  const start = parseStart({ in: options.in, at: options.at }, now);
  if (start === undefined) throw new UsageError('give exactly one of --in, --at or --now');
  return start;
}

export async function runDelay(ctx: Context, input: string, options: DelayOptions): Promise<void> {
  const notBefore = parseDelay(options, new Date());
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  await s.command(updateTaskRoute, {
    id,
    notBefore: notBefore === null ? null : notBefore.toISOString(),
    expect: 'todo',
  });
  confirm(ctx, notBefore === null ? `${id} is due now` : `${id} starts ${localTime(notBefore)}`);
}
