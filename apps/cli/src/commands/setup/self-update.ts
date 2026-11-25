import type { Command } from 'commander';

import { CliError, UsageError } from '../../errors.js';
import {
  checkForUpdate,
  installRelease,
  resumeMigration,
  type UpdateEnv,
} from '../../update/apply.js';
import { runRollback } from '../../update/rollback.js';
import { moveServer } from '../../update/server-move.js';
import { PART_VERSION } from '../../version.js';
import type { Context } from '../context.js';

export interface SelfUpdateOptions {
  readonly check?: boolean;
  readonly resume?: boolean;
  readonly rollback?: boolean;
  readonly server?: string;
}

function updateEnv(ctx: Context): UpdateEnv {
  return { rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun, out: ctx.out };
}

function refuseCombinations(options: SelfUpdateOptions): void {
  const chosen = (['check', 'resume', 'rollback'] as const).filter(
    (name) => options[name] === true,
  );
  if (options.server !== undefined && chosen.length > 0) {
    throw new UsageError(`--server cannot be combined with --${chosen[0]}`);
  }
  if (chosen.length > 1) {
    throw new UsageError(`--${chosen[0]} cannot be combined with --${chosen[1]}`);
  }
}

export async function runSelfUpdate(ctx: Context, options: SelfUpdateOptions): Promise<void> {
  if (ctx.inRun) throw new CliError('`board self-update` cannot run inside a board run');
  refuseCombinations(options);
  const env = updateEnv(ctx);
  if (options.server !== undefined) {
    await moveServer(ctx, options.server);
    return;
  }
  if (options.rollback === true) {
    await runRollback(env);
    return;
  }
  if (options.resume === true) {
    await resumeMigration(env);
    return;
  }
  const { release, newer } = await checkForUpdate(env);
  if (release === null) throw new CliError('this repository has no CLI release yet');
  if (!newer) {
    ctx.out(`board ${PART_VERSION} is the newest release (${release.version})`);
    return;
  }
  if (options.check === true) {
    ctx.out(
      `board ${release.version} is available (this is ${PART_VERSION}); run \`board self-update\``,
    );
    return;
  }
  await installRelease(env, release);
}

export function registerSelfUpdate(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  program
    .command('self-update')
    .description(
      'Install the newest CLI release of this repository, or move this machine to another server',
    )
    .option('--check', 'only say whether a newer release exists')
    .option('--resume', 'finish a local migration that stopped')
    .option('--rollback', 'restore the newest backup and hold auto-update')
    .option('--server <url>', 'point this machine at another server after checking it')
    .action(async (options: SelfUpdateOptions, command: Command) => {
      await runSelfUpdate(withContext(command), options);
    });
}
