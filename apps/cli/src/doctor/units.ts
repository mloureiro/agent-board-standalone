import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DoctorCheckId, DoctorResult } from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import {
  DISPATCH_LOCK_FILE,
  REMOVED_INTAKE_FILES,
  isUnitPlatform,
  launchdFile,
  launchdLoaded,
  parseProgramArguments,
  restartedSystemdUnit,
  runTool,
  systemdService,
  unitDirectory,
  UNIT_NAMES,
  type UnitName,
} from '../units/index.js';
import { pass, problem } from './results.js';

const SETUP = 'run `board setup`';

const COMMAND_IDS: Record<UnitName, DoctorCheckId> = {
  dispatch: 'dispatch command',
  listen: 'listen command',
  watch: 'watch command',
};

const STATE_IDS: Record<UnitName, DoctorCheckId> = {
  dispatch: 'dispatch state',
  listen: 'listen state',
  watch: 'watch state',
};

export function parseExecStart(unit: string): string[] | undefined {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  if (line === undefined) return undefined;
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) =>
    (match[1]?.replace(/\\(.)/g, '$1') ?? match[2] ?? '')
      .replaceAll('%%', '%')
      .replaceAll('$$', '$'),
  );
}

function executable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandOf(unit: UnitName, args: readonly string[]): string[] {
  if (unit !== 'dispatch') return [...args];
  const lock = args.findIndex((arg) => path.basename(arg) === DISPATCH_LOCK_FILE);
  return lock < 0 ? [...args] : args.slice(lock + 1);
}

function commandCheck(
  unit: UnitName,
  file: string,
  args: readonly string[] | undefined,
): DoctorResult {
  const id = COMMAND_IDS[unit];
  if (args === undefined) {
    return problem(id, 'fail', `${file} has no command`, `${SETUP} again to rewrite it`);
  }
  const [program, script] = commandOf(unit, args);
  if (program === undefined || !path.isAbsolute(program) || !executable(program)) {
    return problem(
      id,
      'fail',
      `${program ?? 'the program'} in ${path.basename(file)} is not an executable file`,
      `${SETUP} again from the board you want the units to run`,
    );
  }
  if (script !== undefined && path.isAbsolute(script) && !existsSync(script)) {
    return problem(
      id,
      'fail',
      `${script} in ${path.basename(file)} does not exist`,
      `${SETUP} again`,
    );
  }
  return pass(id, [program, script].filter((part) => part !== undefined).join(' '));
}

function stateProblem(unit: UnitName): DoctorResult {
  return problem(
    STATE_IDS[unit],
    'warn',
    `the ${unit} unit is installed but not running`,
    'run `board setup --enable`',
  );
}

export async function unitChecks(ctx: Context): Promise<DoctorResult[]> {
  const { platform } = ctx.rt;
  if (!isUnitPlatform(platform)) return [];
  const directory = unitDirectory(ctx.rt, platform);
  const { profile } = ctx.dirs;
  const results: DoctorResult[] = [];
  if (platform === 'linux') {
    const leftover = REMOVED_INTAKE_FILES.filter((name) => existsSync(path.join(directory, name)));
    results.push(
      leftover.length === 0
        ? pass('unit agent-board-intake', 'the removed intake unit is not installed')
        : problem(
            'unit agent-board-intake',
            'warn',
            `${leftover.join(', ')} still sit in ${directory}`,
            `${SETUP} removes them`,
          ),
    );
  }
  const present = UNIT_NAMES.map((unit) => {
    const name = platform === 'darwin' ? launchdFile(profile, unit) : systemdService(profile, unit);
    return { unit, file: path.join(directory, name) };
  });
  if (platform === 'darwin') {
    const missing = present.filter((entry) => !existsSync(entry.file));
    results.push(
      missing.length === 0
        ? pass('launchd agents', `all three agents are installed in ${directory}`)
        : problem(
            'launchd agents',
            'warn',
            `not installed in ${directory}: ${missing.map((entry) => path.basename(entry.file)).join(', ')}`,
            SETUP,
          ),
    );
  }
  for (const { unit, file } of present) {
    if (!existsSync(file)) {
      if (platform === 'linux') {
        results.push(
          problem(COMMAND_IDS[unit], 'warn', `${path.basename(file)} is not installed`, SETUP),
        );
      }
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const args = platform === 'darwin' ? parseProgramArguments(text) : parseExecStart(text);
    results.push(commandCheck(unit, file, args));
    results.push(await stateCheck(ctx, platform, unit));
  }
  return results;
}

async function stateCheck(
  ctx: Context,
  platform: 'darwin' | 'linux',
  unit: UnitName,
): Promise<DoctorResult> {
  const running =
    platform === 'darwin'
      ? await launchdLoaded(ctx.rt, ctx.dirs.profile, unit)
      : (
          await runTool(ctx.rt, 'systemctl', [
            '--user',
            'is-active',
            restartedSystemdUnit(ctx.dirs.profile, unit),
          ])
        ).code === 0;
  return running
    ? pass(STATE_IDS[unit], platform === 'darwin' ? 'loaded in launchd' : 'active in systemd')
    : stateProblem(unit);
}
