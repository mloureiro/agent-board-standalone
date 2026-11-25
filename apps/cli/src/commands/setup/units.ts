import { Argument, type Command } from 'commander';

import {
  DEFAULT_LINES,
  UNIT_NAMES,
  runLogs,
  runRestart,
  runSetup,
  runUninstall,
  type LogsOptions,
  type SetupOptions,
  type UninstallOptions,
} from '../../units/index.js';
import type { Context } from '../context.js';

export function registerUnitCommands(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  program
    .command('setup')
    .description('Write the worker units for this profile: systemd user units or launchd agents')
    .option('--enable', 'enable and start the units after writing them')
    .option('--force', 'install although this board is not the installed one')
    .option('--print', 'print the unit files without writing them')
    .action(async (options: SetupOptions, command: Command) => {
      await runSetup(withContext(command), options);
    });

  program
    .command('uninstall')
    .description('Stop and delete the units of this profile and revoke the machine token')
    .option('--include-optional', 'also delete the config, state and run folders')
    .option('--dry-run', 'print what would be done')
    .action(async (options: UninstallOptions, command: Command) => {
      await runUninstall(withContext(command), options);
    });

  program
    .command('restart')
    .description('Restart the worker units of this profile')
    .addArgument(new Argument('[unit...]', 'dispatch, listen or watch').choices(UNIT_NAMES))
    .action(async (units: string[], _options: unknown, command: Command) => {
      await runRestart(withContext(command), units);
    });

  program
    .command('logs')
    .description('Show the log of a worker unit or of a task')
    .argument('[target]', 'dispatch, listen, watch or a task id')
    .option('-f, --follow', 'keep printing new lines')
    .option('-n, --lines <n>', 'how many lines to print', DEFAULT_LINES)
    .option('--since <time>', 'only lines since this time (Linux units only)')
    .action(async (target: string | undefined, options: LogsOptions, command: Command) => {
      await runLogs(withContext(command), target, options);
    });
}
