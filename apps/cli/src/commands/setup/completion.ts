import { Argument, type Command } from 'commander';
import { stringify } from 'yaml';

import { EXAMPLES } from '../../agents/examples.js';
import {
  COMPLETION_KINDS,
  SHELLS,
  completeIds,
  completionScript,
  type CompletionKind,
  type Shell,
} from '../../completion/index.js';
import { UsageError } from '../../errors.js';
import type { Context } from '../context.js';

function treeOf(program: Command) {
  const visible = program.createHelp().visibleCommands(program);
  const named = (command: Command): string => command.name();
  return {
    commands: [...visible.map(named), 'help'],
    taskCommands: visible
      .filter((command) => command.registeredArguments[0]?.name() === 'task')
      .map(named),
  };
}

export function registerCompletion(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  program
    .command('completion')
    .description('Print the shell completion script for bash, zsh or fish')
    .addArgument(new Argument('<shell>', 'the shell').choices(SHELLS))
    .action((shell: Shell, _options: unknown, command: Command) => {
      withContext(command).out(completionScript(shell, treeOf(program)).trimEnd());
    });

  program
    .command('__complete', { hidden: true })
    .description('Print task or schedule ids, one per line, for the completion scripts')
    .argument('[kind]', COMPLETION_KINDS.join(' or '))
    .allowExcessArguments()
    .action(async (kind: string | undefined, _options: unknown, command: Command) => {
      if (!(COMPLETION_KINDS as readonly string[]).includes(kind ?? '')) return;
      try {
        const ctx = withContext(command);
        for (const id of await completeIds(ctx, kind as CompletionKind)) ctx.out(id);
      } catch {
        return;
      }
    });

  program
    .command('example')
    .description('List the example agent definitions, or print one')
    .argument('[name]', 'the example to print')
    .action((name: string | undefined, _options: unknown, command: Command) => {
      const ctx = withContext(command);
      if (name === undefined) {
        for (const example of Object.keys(EXAMPLES)) ctx.out(example);
        return;
      }
      const definition = EXAMPLES[name];
      if (definition === undefined) {
        throw new UsageError(
          `no example "${name.slice(0, 40)}"; the examples are ${Object.keys(EXAMPLES).join(', ')}`,
        );
      }
      ctx.out(stringify(definition).trimEnd());
    });
}
