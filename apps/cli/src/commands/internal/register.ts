import { Command, InvalidArgumentError } from 'commander';

import { CliError, EXIT, ReportedFailure, UsageError } from '../../errors.js';
import { runSelfTest, selfTestPassed } from '../../selftest.js';
import {
  DEFAULT_SHUTDOWN_GRACE_S,
  createRunFiles,
  shutdownWorkers,
  systemProcessOps,
} from '../../shutdown/index.js';
import { runDispatch } from '../../dispatch/run.js';
import { runListener } from '../../dispatch/listen.js';
import { now } from '../../transport/clock.js';
import { runWatchCommand } from '../../watch/unit.js';
import { runHook } from '../../worker/hook.js';
import { runWorker } from '../../worker/run.js';
import { describePlan, planMigration, readPendingMigration } from '../../update/migrations.js';
import { isUnitPlatform, resolveWorkerUnits } from '../../units/index.js';
import { PART_VERSION } from '../../version.js';
import type { Context } from '../context.js';

const SUBCOMMANDS = [
  'dispatch',
  'listen',
  'watch',
  'worker',
  'hook',
  'units',
  'shutdown',
  'migration-plan',
  'selftest',
];

function refuseInRun(ctx: Context, name: string): void {
  if (ctx.inRun) throw new CliError(`\`board internal ${name}\` cannot run inside a board run`);
}

export function graceSeconds(text: string): number {
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidArgumentError('--grace takes a number of seconds above 0');
  }
  return seconds;
}

export function runUnits(ctx: Context): void {
  refuseInRun(ctx, 'units');
  const { rt, dirs } = ctx;
  if (!isUnitPlatform(rt.platform)) {
    throw new CliError(`board internal units needs Linux or macOS; this is ${rt.platform}`);
  }
  const units = resolveWorkerUnits({
    platform: rt.platform,
    home: rt.homedir,
    profile: dirs.profile,
    self: rt.self,
    env: rt.env,
  });
  ctx.out(JSON.stringify(units));
}

export async function runShutdown(ctx: Context, grace: number): Promise<void> {
  refuseInRun(ctx, 'shutdown');
  if (ctx.dryRun) {
    ctx.out(`DRY shutdown workers in ${ctx.dirs.run}`);
    return;
  }
  await shutdownWorkers({
    files: createRunFiles(ctx.dirs.run),
    processes: systemProcessOps,
    graceMs: grace * 1000,
    now: () => now(ctx.rt.env),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    print: ctx.out,
  });
}

export function runMigrationPlan(ctx: Context): void {
  refuseInRun(ctx, 'migration-plan');
  const pending = readPendingMigration(ctx.dirs.state);
  const from = pending?.from ?? PART_VERSION;
  const steps = describePlan(planMigration(from, PART_VERSION));
  ctx.out(JSON.stringify({ from, to: PART_VERSION, steps }));
}

export async function runSelfTestCommand(ctx: Context): Promise<void> {
  const report = await runSelfTest();
  ctx.out(JSON.stringify(report));
  if (!selfTestPassed(report)) throw new ReportedFailure(EXIT.failure);
}

export function registerInternal(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  const internal = program
    .command('internal', { hidden: true })
    .description('Commands the units and the server app call')
    .action(() => {
      throw new UsageError(`board internal needs a subcommand: ${SUBCOMMANDS.join(', ')}`);
    });

  internal
    .command('dispatch')
    .description('Run one dispatch tick: sweep, wake, claim and start workers')
    .option('--dry-run', 'read everything and print every write and process start instead')
    .action(async (_options: unknown, command: Command) => {
      await runDispatch(withContext(command));
    });

  internal
    .command('listen')
    .description('Hold the event stream of the board and run a tick on each change')
    .action(async (_options: unknown, command: Command) => {
      await runListener(withContext(command));
    });

  internal
    .command('watch')
    .description('Run the watches stored by `board watch` and wake the tasks they end')
    .action(async (_options: unknown, command: Command) => {
      await runWatchCommand(withContext(command));
    });

  internal
    .command('worker')
    .argument('<task>', 'the claimed task to run')
    .description('Run the agent of one claimed task')
    .action(async (task: string, _options: unknown, command: Command) => {
      const code = await runWorker(withContext(command), task);
      if (code !== 0) throw new ReportedFailure(code);
    });

  internal
    .command('hook')
    .argument('[args...]', 'the run directory and the task')
    .allowUnknownOption()
    .passThroughOptions()
    .description('The PreToolUse hook of a run: liveness, working directory and worktree lock')
    .action(async (args: string[], _options: unknown, command: Command) => {
      await runHook(withContext(command), args);
    });

  internal
    .command('units')
    .description('Print the worker unit recipe as JSON')
    .action((_options: unknown, command: Command) => {
      runUnits(withContext(command));
    });

  internal
    .command('shutdown')
    .description('Pause every running worker so it resumes later, and stop the stragglers')
    .option(
      '--grace <seconds>',
      'how long workers get to pause',
      graceSeconds,
      DEFAULT_SHUTDOWN_GRACE_S,
    )
    .action(async (options: { grace: number }, command: Command) => {
      await runShutdown(withContext(command), options.grace);
    });

  internal
    .command('migration-plan')
    .description('Print the local migration steps the next update would run, as JSON')
    .option('--json', 'print JSON (the output is JSON anyway)')
    .action((_options: unknown, command: Command) => {
      runMigrationPlan(withContext(command));
    });

  internal
    .command('selftest')
    .description('Seal and open through the sealing package, to prove a build works')
    .action(async (_options: unknown, command: Command) => {
      await runSelfTestCommand(withContext(command));
    });
}
