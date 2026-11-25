import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runDirs, type DirsOptions } from './dirs.js';

export function registerDirs(program: Command, withContext: (command: Command) => Context): void {
  dryRun(
    program
      .command('dirs')
      .description('List, add, remove and set the directories workers may run in')
      .usage(
        '[options] [list | add [path] | rm [path] | set <key> <value> [path] | unset <key> [path]]',
      )
      .argument('[action...]', 'list, add, rm, set or unset')
      .option('--from-config', 'with add: add every directory the config names')
      .option('--no-repo', 'with add: do not set repo from the git remote')
      .option('--force', 'with rm: remove even while open work uses the directory'),
  ).action(async (action: string[], options: DirsOptions, command: Command) => {
    await runDirs(withContext(command), action, options);
  });
}
