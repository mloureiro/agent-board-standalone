import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { ProfileDirs } from '../profile/paths.js';
import type { ExecResult, Runtime } from '../runtime.js';
import { launchdLabel, type UnitName } from './names.js';
import { isUnitPlatform, type UnitPlatform } from './recipe.js';

const TOOL_TIMEOUT_MS = 30_000;
const TOOL_MAX_BYTES = 1024 * 1024;

export function requireUnitPlatform(rt: Runtime, command: string): UnitPlatform {
  if (!isUnitPlatform(rt.platform)) {
    throw new CliError(
      `board ${command} needs Linux with systemd or macOS; this is ${rt.platform}`,
    );
  }
  return rt.platform;
}

export function systemdDirectory(rt: Runtime): string {
  const base = rt.env.XDG_CONFIG_HOME;
  const root =
    base !== undefined && path.isAbsolute(base) ? base : path.join(rt.homedir, '.config');
  return path.join(root, 'systemd', 'user');
}

export function launchAgentsDirectory(rt: Runtime): string {
  return path.join(rt.homedir, 'Library', 'LaunchAgents');
}

export function unitDirectory(rt: Runtime, platform: UnitPlatform): string {
  return platform === 'darwin' ? launchAgentsDirectory(rt) : systemdDirectory(rt);
}

export const logDirectory = (dirs: ProfileDirs): string => path.join(dirs.state, 'logs');

export function installedBoard(rt: Runtime): string {
  const base = rt.env.BOARD_INSTALL_DIR;
  const directory =
    base !== undefined && path.isAbsolute(base) ? base : path.join(rt.homedir, '.local', 'bin');
  return path.join(directory, 'board');
}

export function findProgram(rt: Runtime, name: string): string | undefined {
  for (const directory of (rt.env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function runTool(
  rt: Runtime,
  file: string,
  args: readonly string[],
): Promise<ExecResult> {
  try {
    return await rt.exec(file, args, { timeoutMs: TOOL_TIMEOUT_MS, maxBytes: TOOL_MAX_BYTES });
  } catch {
    return { code: 127, stdout: '' };
  }
}

export async function launchdLoaded(
  rt: Runtime,
  profile: string,
  unit: UnitName,
): Promise<boolean> {
  const result = await runTool(rt, 'launchctl', ['print', launchdTarget(rt.uid, profile, unit)]);
  return result.code === 0;
}

export const launchdTarget = (uid: number, profile: string, unit: UnitName): string =>
  `gui/${uid}/${launchdLabel(profile, unit)}`;

export function installProblem(rt: Runtime): string | null {
  const [program = '', script] = rt.self;
  const running = script ?? program;
  const temporary = [rt.env.TMPDIR, '/tmp'].flatMap((entry) =>
    entry === undefined || entry === '' ? [] : [safeRealpath(entry)],
  );
  const real = safeRealpath(running);
  if (temporary.some((directory) => real.startsWith(`${directory}${path.sep}`))) {
    return `this board runs from ${real}, in the temp directory; install it and run \`board setup\` from there`;
  }
  const installed = installedBoard(rt);
  if (existsSync(installed) && safeRealpath(installed) !== real) {
    return `this board (${real}) is not the one installed at ${installed}`;
  }
  return null;
}

export function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}
