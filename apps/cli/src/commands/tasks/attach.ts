import { statSync } from 'node:fs';

import { attachSessionRoute } from '@agent-board/contract';
import { bindings, open } from '@agent-board/sealing';

import { CliError, ReportedFailure, UsageError } from '../../errors.js';
import { plain } from '../../domain/rules.js';
import { readLocalDirectories } from '../../directories/local.js';
import { ApiError } from '../../transport/errors.js';
import type { Context } from '../context.js';
import { refuseInRun, resolveTask, session } from './support.js';

export interface AttachOptions {
  readonly fork?: boolean;
  readonly desktop?: boolean;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export async function runAttach(
  ctx: Context,
  input: string,
  options: AttachOptions,
): Promise<void> {
  refuseInRun(ctx, 'board attach');
  if (options.desktop === true && options.fork === true) {
    throw new UsageError('--desktop and --fork cannot be combined');
  }
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  let wire;
  try {
    wire = await s.query(attachSessionRoute, { id });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 403)) {
      throw new UsageError(error.message);
    }
    throw error;
  }
  if (wire.sessionId === null) throw new UsageError(`${id} has no Claude session to attach to`);
  let workdir: string | null = null;
  if (wire.directoryId !== null) {
    workdir =
      readLocalDirectories(ctx.dirs.config).entries.find((entry) => entry.id === wire.directoryId)
        ?.path ?? null;
  }
  if (workdir === null && wire.legacyDirectory !== null) {
    const candidates =
      wire.scheduleId === null
        ? [{ task: id }]
        : [{ schedule: wire.scheduleId }, { task: id, schedule: wire.scheduleId }];
    for (const origin of candidates) {
      try {
        workdir = await open(s.keys, bindings.workdir(origin), wire.legacyDirectory);
        break;
      } catch {
        workdir = null;
      }
    }
  }
  if (workdir === null || !isDirectory(workdir)) {
    throw new UsageError(
      workdir === null
        ? `the directory of ${id} is unknown on this machine`
        : `the directory of ${id} is not there: ${plain(workdir)}`,
    );
  }
  const args = [
    ...(options.desktop === true ? ['--desktop'] : []),
    '--resume',
    wire.sessionId,
    ...(options.fork === true ? ['--fork-session'] : []),
  ];
  if (ctx.dryRun) {
    ctx.out(`DRY claude ${args.join(' ')}  (in ${plain(workdir)})`);
    return;
  }
  let code: number;
  try {
    code = await ctx.rt.spawnInteractive('claude', args, { cwd: workdir });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('claude is not on the PATH: install Claude Code to attach to a session');
    }
    throw error;
  }
  if (code !== 0) throw new ReportedFailure(code, `claude exited with code ${code}`);
}
