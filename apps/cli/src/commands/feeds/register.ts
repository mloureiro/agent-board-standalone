import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runFeeds } from './feeds.js';

export function registerFeeds(program: Command, withContext: (command: Command) => Context): void {
  dryRun(
    program
      .command('feeds')
      .description('Manage feeds: each item an integration lists becomes a keyed Todo task')
      .usage(
        '[options] [list | add <name> <file|-> | rm <name> | run <name> | pause <name> | resume <name>]',
      )
      .argument('[action...]', 'list, add, rm, run, pause or resume'),
  ).action(async (action: string[], _options: unknown, command: Command) => {
    await runFeeds(withContext(command), action);
  });
}
