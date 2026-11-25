import { CliError } from '../../errors.js';
import { ApiError } from '../../transport/errors.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { refuseInRun } from '../tasks/support.js';

export function userCommand(ctx: Context, name: string): void {
  refuseInRun(ctx, `board ${name}`);
}

export function grantMessage(s: Session): string {
  return `this machine (${s.machine}) may not act as you yet. Grant it in Settings › Machines on the board (${s.url}), then run the command again.`;
}

export async function asOwner<T>(s: Session, id: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'grant-required') {
      throw new CliError(grantMessage(s));
    }
    if (error instanceof ApiError && error.code === 'run-holds-task') {
      throw new CliError(
        `${id} is held by a run of this machine, which may not act on its own task as you`,
      );
    }
    throw error;
  }
}
