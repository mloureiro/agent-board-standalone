import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runConfig } from './config.js';

export function registerConfig(program: Command, withContext: (command: Command) => Context): void {
  dryRun(
    program
      .command('config')
      .description(
        'Show and edit this profile\'s config file; keys below dirs go through "rumo dirs"',
      )
      .usage('[options] [show | get <key> | set <key> <value> | unset <key> | edit | path]')
      .argument('[action...]', 'show, get, set, unset, edit or path')
      .option('--json', 'with show: print the config as JSON'),
  ).action(async (action: string[], options: { json?: boolean }, command: Command) => {
    await runConfig(withContext(command), action, options);
  });
}
