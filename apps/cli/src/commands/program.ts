import { Command, CommanderError } from 'commander';

import { CliError, EXIT } from '../errors.js';
import type { Runtime } from '../runtime.js';
import { buildContext, type Context, type GlobalOptions } from './context.js';
import { registerConfig } from './config/index.js';
import { registerDirs } from './dirs/index.js';
import { registerProjects } from './projects/index.js';
import { registerSchedule } from './schedule/index.js';
import { registerInit } from './setup/init.js';
import { registerTaskCommands } from './tasks/index.js';
import { registerUserCommands } from './user/index.js';
import { cliVersionLine, registerVersion } from './setup/version.js';

const CLEAN_EXIT_CODES = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);

export function buildProgram(rt: Runtime): Command {
  const program = new Command('board');
  program
    .enablePositionalOptions()
    .exitOverride()
    .showSuggestionAfterError()
    .configureOutput({
      writeOut: (text) => {
        rt.io.stdout(text);
      },
      writeErr: (text) => {
        rt.io.stderr(text);
      },
      outputError: (text, write) => {
        write(`board: ${text.replace(/^error: /, '')}`);
      },
    })
    .version(cliVersionLine(), '-V, --version', 'print the CLI version')
    .option('--profile <name>', 'the profile to use (default: AGENT_BOARD_PROFILE or "default")')
    .option('--dry-run', 'perform all reads and print each write as DRY <command>');

  const withContext = (command: Command): Context => {
    const local = command.opts<{ dryRun?: boolean }>().dryRun === true;
    return buildContext(rt, program.opts<GlobalOptions>(), local);
  };

  registerVersion(program, withContext);
  registerInit(program, withContext);
  registerTaskCommands(program, withContext);
  registerUserCommands(program, withContext);
  registerSchedule(program, withContext);
  registerDirs(program, withContext);
  registerProjects(program, withContext);
  registerConfig(program, withContext);
  return program;
}

export async function runCli(argv: readonly string[], rt: Runtime): Promise<number> {
  const program = buildProgram(rt);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      return CLEAN_EXIT_CODES.has(error.code) ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof CliError) {
      if (error.message !== '') rt.io.stderr(`board: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    rt.io.stderr(`board: ${message}\n`);
    return EXIT.failure;
  }
}
