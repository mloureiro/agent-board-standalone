import { updateTaskRoute } from '@agent-board/contract';

import { EXIT, ReportedFailure, UsageError } from '../../errors.js';
import { parseStatus } from '../../domain/rules.js';
import { ApiError } from '../../transport/errors.js';
import { WatchStore } from '../../watch/store.js';
import { publishWatches } from '../../watch/publish.js';
import type { Context } from '../context.js';
import { confirm, fenceOf, refuseInRun, resolveTask, session, taskLink } from './support.js';

export async function runMove(
  ctx: Context,
  input: string,
  statusWords: readonly string[],
  options: { expect?: string; fresh?: boolean },
): Promise<void> {
  if (options.expect !== undefined) {
    refuseInRun(ctx, 'board move --expect');
  }
  if (options.fresh === true) {
    refuseInRun(ctx, 'board move --fresh');
  }
  const status = parseStatus(statusWords.join(' '));
  if (options.fresh === true && status !== 'todo') {
    throw new UsageError('--fresh applies when moving a task to todo');
  }
  const expect = options.expect === undefined ? undefined : parseStatus(options.expect);
  if (status === 'waiting') {
    throw new UsageError(
      `a wait needs its end: use "board wait ${input} --in <dur>" or "--check '<command>'" instead`,
    );
  }
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  try {
    await s.command(updateTaskRoute, {
      id,
      status,
      ...fenceOf(ctx, id),
      ...(expect === undefined ? {} : { expect }),
      ...(options.fresh === true ? { next: 'fresh' as const } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (expect !== undefined && error.status === 409) {
      const message = `${id} is not in ${expect} any more; nothing was moved`;
      ctx.err(`board: ${message}`);
      throw new ReportedFailure(EXIT.expectMismatch);
    }
    if (error.status === 409) {
      throw new UsageError(
        `${id} was not moved: ${error.message}. From inside a run the board moves the run's task only while that run holds it. If you are that run, it was taken back or has ended: do not move it again, end your turn.`,
      );
    }
    if (error.status === 403) throw new UsageError(`${id} was not moved: ${error.message}`);
    throw error;
  }
  if (status === 'needs-me' && ctx.runTask === id && !ctx.dryRun) {
    const store = new WatchStore(ctx.dirs.state);
    if (store.dropTask(id) > 0) {
      await publishWatches(s, store, id, (line) => {
        ctx.err(line);
      });
    }
  }
  confirm(ctx, `moved ${id} to ${status}  ${taskLink(s, id)}`);
}
