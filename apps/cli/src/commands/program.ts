import { Command, CommanderError } from 'commander';

import { CliError, EXIT } from '../errors.js';
import type { Runtime } from '../runtime.js';
import { buildContext, type Context, type GlobalOptions } from './context.js';
import { showUpdateHint } from '../update/hint.js';
import { registerAgents } from './agents/index.js';
import { registerConfig } from './config/index.js';
import { registerDirs } from './dirs/index.js';
import { registerFeeds } from './feeds/index.js';
import { registerInternal } from './internal/index.js';
import { registerPlugins } from './plugins/index.js';
import { registerProjects } from './projects/index.js';
import { registerSchedule } from './schedule/index.js';
import { registerCompletion } from './setup/completion.js';
import { registerDoctor } from './setup/doctor.js';
import { registerInit } from './setup/init.js';
import { registerSelfUpdate } from './setup/self-update.js';
import { registerUnitCommands } from './setup/units.js';
import { registerTaskCommands } from './tasks/index.js';
import { registerUserCommands } from './user/index.js';
import { cliVersionLine, registerVersion } from './setup/version.js';

const CLEAN_EXIT_CODES = new Set([
  'commander.help',
  'commander.helpDisplayed',
  'commander.version',
]);

const QUIET_COMMANDS = new Set(['internal', '__complete', 'completion', 'self-update']);

export function buildProgram(rt: Runtime): Command {
  const program = new Command('rumo');
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
        write(`rumo: ${text.replace(/^error: /, '')}`);
      },
    })
    .version(cliVersionLine(), '-V, --version', 'print the CLI version')
    .option('--profile <name>', 'the profile to use (default: RUMO_PROFILE or "default")')
    .option('--dry-run', 'perform all reads and print each write as DRY <command>');

  const withContext = (command: Command): Context => {
    const local = command.opts<{ dryRun?: boolean }>().dryRun === true;
    return buildContext(rt, program.opts<GlobalOptions>(), local);
  };

  registerVersion(program, withContext);
  registerInit(program, withContext);
  registerDoctor(program, withContext);
  registerUnitCommands(program, withContext);
  registerTaskCommands(program, withContext);
  registerUserCommands(program, withContext);
  registerSchedule(program, withContext);
  registerDirs(program, withContext);
  registerProjects(program, withContext);
  registerConfig(program, withContext);
  registerAgents(program, withContext);
  registerFeeds(program, withContext);
  registerPlugins(program, withContext);
  registerSelfUpdate(program, withContext);
  registerCompletion(program, withContext);

  program.hook('postAction', (_root, action) => {
    let top = action;
    while (top.parent !== null && top.parent !== program) top = top.parent;
    if (QUIET_COMMANDS.has(top.name())) return;
    const ctx = withContext(action);
    showUpdateHint(
      { rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun, out: ctx.out },
      rt.io.stderrIsTty,
      ctx.inRun,
    );
  });

  registerInternal(program, withContext);
  return program;
}

export function expandVersionServer(argv: readonly string[]): string[] {
  const asksVersion = argv.includes('--version') || argv.includes('-V');
  if (!asksVersion || !argv.includes('--server')) return [...argv];
  const rest = argv.filter((arg) => !['--version', '-V', '--server'].includes(arg));
  const onlyGlobals = rest.every((arg, at) => arg === '--profile' || rest[at - 1] === '--profile');
  return onlyGlobals ? [...rest, 'version'] : [...argv];
}

export async function runCli(argv: readonly string[], rt: Runtime): Promise<number> {
  const program = buildProgram(rt);
  try {
    await program.parseAsync(expandVersionServer(argv), { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      return CLEAN_EXIT_CODES.has(error.code) ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof CliError) {
      if (error.message !== '') rt.io.stderr(`rumo: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    rt.io.stderr(`rumo: ${message}\n`);
    return EXIT.failure;
  }
}
