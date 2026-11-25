import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runAgents, type AgentsOptions } from './agents.js';

export function registerAgents(program: Command, withContext: (command: Command) => Context): void {
  dryRun(
    program
      .command('agents')
      .description('Manage the agent definitions of this machine and the ones shared on the board')
      .usage(
        '[options] [list | show <name> | export <name> | add <file|-|https-url|example:name> | push <name|file|-|url|example:name> | rm [--board] <name>]',
      )
      .argument('[action...]', 'list, show, export, add, push or rm')
      .option('--json', 'list, show and export: print JSON')
      .option('--yaml', 'show and export: print YAML')
      .option(
        '--name <name>',
        'add and push: the agent name (default: the document name, else the file name)',
      )
      .option('--replace', 'add: replace an agent of the same name')
      .option('-y, --yes', 'add and push: do not ask')
      .option('--board', 'rm: remove the agent from the board instead of this machine'),
  ).action(async (action: string[], options: AgentsOptions, command: Command) => {
    await runAgents(withContext(command), action, options);
  });
}
