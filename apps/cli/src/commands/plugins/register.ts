import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runPlugins } from './plugins.js';

export function registerPlugins(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  dryRun(
    program
      .command('plugins')
      .description(
        'Install feed integrations from git, pinned to a commit and never taken from PATH',
      )
      .usage('[options] [list | install <url> | update <name> | remove <name>]')
      .argument('[action...]', 'list, install, update or remove'),
  ).action(async (action: string[], _options: unknown, command: Command) => {
    await runPlugins(withContext(command), action);
  });
}
