import type { Command } from 'commander';

import type { Context } from '../context.js';
import { dryRun } from '../options.js';
import { runProjects } from './projects.js';

export function registerProjects(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  dryRun(
    program
      .command('projects')
      .description("List the board's projects, or set this host's default project")
      .usage('[options] [list | default <id>]')
      .argument('[action...]', 'list, or default <id>')
      .option('--json', 'print the projects as JSON'),
  ).action(async (action: string[], options: { json?: boolean }, command: Command) => {
    await runProjects(withContext(command), action, options);
  });
}
