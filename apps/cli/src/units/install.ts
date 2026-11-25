import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CliError } from '../errors.js';
import type { Context } from '../commands/context.js';
import {
  findProgram,
  installProblem,
  launchdLoaded,
  launchdTarget,
  logDirectory,
  requireUnitPlatform,
  runTool,
  unitDirectory,
} from './layout.js';
import { REMOVED_INTAKE_FILES, systemdEnabled, systemdService, UNIT_NAMES } from './names.js';
import { renderLaunchd } from './launchd.js';
import { resolveWorkerUnits, type UnitPlatform } from './recipe.js';
import { renderSystemd, type UnitFile } from './systemd.js';

export interface SetupOptions {
  readonly enable?: boolean;
  readonly force?: boolean;
  readonly print?: boolean;
}

export function renderUnitFiles(ctx: Context, platform: UnitPlatform): UnitFile[] {
  const { rt, dirs } = ctx;
  const recipe = resolveWorkerUnits({
    platform,
    home: rt.homedir,
    profile: dirs.profile,
    self: rt.self,
    env: rt.env,
  });
  if (platform === 'darwin') {
    return renderLaunchd({
      profile: dirs.profile,
      recipe,
      runDir: dirs.run,
      logDir: logDirectory(dirs),
      env: rt.env,
    });
  }
  const flock = findProgram(rt, 'flock');
  if (flock === undefined) {
    throw new CliError('flock is not on PATH; install util-linux and run `board setup` again');
  }
  return renderSystemd({ profile: dirs.profile, recipe, runDir: dirs.run, flock, env: rt.env });
}

function differences(file: string, before: string, after: string): string[] {
  const old = before.split('\n');
  const next = after.split('\n');
  return [
    `~ ${file} differs from what setup writes:`,
    ...old.filter((line) => !next.includes(line)).map((line) => `    - ${line}`),
    ...next.filter((line) => !old.includes(line)).map((line) => `    + ${line}`),
  ];
}

function installCopy(ctx: Context, target: string, unit: UnitFile): boolean {
  let before: string | undefined;
  try {
    before = readFileSync(target, 'utf8');
  } catch {
    before = undefined;
  }
  if (before === unit.text) {
    ctx.out(`unchanged ${target}`);
    return false;
  }
  if (before !== undefined)
    for (const line of differences(unit.file, before, unit.text)) ctx.out(line);
  if (ctx.dryRun) {
    ctx.out(`DRY write ${target}`);
    return true;
  }
  rmSync(target, { force: true });
  writeFileSync(target, unit.text, { mode: 0o644 });
  ctx.out(`wrote ${target}`);
  return true;
}

async function tool(ctx: Context, file: string, args: readonly string[]): Promise<void> {
  if (ctx.dryRun) {
    ctx.out(`DRY ${file} ${args.join(' ')}`);
    return;
  }
  const result = await runTool(ctx.rt, file, args);
  if (result.code !== 0)
    throw new CliError(`${file} ${args.join(' ')} failed (exit ${result.code})`);
}

async function quietly(ctx: Context, file: string, args: readonly string[]): Promise<void> {
  if (ctx.dryRun) {
    ctx.out(`DRY ${file} ${args.join(' ')}`);
    return;
  }
  await runTool(ctx.rt, file, args);
}

function prepareDirectories(ctx: Context, directory: string): void {
  if (ctx.dryRun) return;
  mkdirSync(directory, { recursive: true });
  mkdirSync(logDirectory(ctx.dirs), { recursive: true, mode: 0o700 });
  mkdirSync(ctx.dirs.run, { recursive: true, mode: 0o700 });
}

async function removeIntake(ctx: Context, directory: string): Promise<void> {
  const leftover = REMOVED_INTAKE_FILES.filter((file) => existsSync(path.join(directory, file)));
  if (leftover.length === 0) return;
  await quietly(ctx, 'systemctl', ['--user', 'disable', '--now', 'agent-board-intake.timer']);
  await quietly(ctx, 'systemctl', ['--user', 'stop', 'agent-board-intake.service']);
  for (const file of leftover) if (!ctx.dryRun) rmSync(path.join(directory, file), { force: true });
  ctx.out(`removed ${leftover.join(' and ')}: the built-in intake no longer exists`);
}

async function setupSystemd(ctx: Context, units: UnitFile[], options: SetupOptions): Promise<void> {
  const directory = unitDirectory(ctx.rt, 'linux');
  const profile = ctx.dirs.profile;
  prepareDirectories(ctx, directory);
  await removeIntake(ctx, directory);
  const changedServices: string[] = [];
  for (const unit of units) {
    const written = installCopy(ctx, path.join(directory, unit.file), unit);
    const isLong =
      unit.file === systemdService(profile, 'listen') ||
      unit.file === systemdService(profile, 'watch');
    if (written && isLong) changedServices.push(unit.file);
  }
  await tool(ctx, 'systemctl', ['--user', 'daemon-reload']);
  for (const service of changedServices) {
    await tool(ctx, 'systemctl', ['--user', 'try-restart', service]);
    ctx.out(`restarted ${service} if it was running, to run the new unit`);
  }
  const enabled = systemdEnabled(profile);
  if (options.enable === true) {
    await tool(ctx, 'systemctl', ['--user', 'enable', '--now', ...enabled]);
    ctx.out('enabled and started the dispatch timer, the listener and the watch unit');
    return;
  }
  const states = await Promise.all(
    enabled.map(
      async (unit) =>
        (await runTool(ctx.rt, 'systemctl', ['--user', 'is-enabled', unit])).code === 0,
    ),
  );
  if (states.every(Boolean)) {
    ctx.out(
      'the timer, the listener and the watch unit are enabled already; the next tick runs the new units',
    );
  } else {
    ctx.out(
      `Enable the timer, the listener and the watch unit when you are ready:\n  systemctl --user enable --now ${enabled.join(' ')}`,
    );
  }
}

async function setupLaunchd(ctx: Context, units: UnitFile[], options: SetupOptions): Promise<void> {
  const directory = unitDirectory(ctx.rt, 'darwin');
  const profile = ctx.dirs.profile;
  const { uid } = ctx.rt;
  prepareDirectories(ctx, directory);
  const files = units.map((unit) => path.join(directory, unit.file));
  const changed = units.map((unit, at) => installCopy(ctx, files[at] ?? '', unit));
  const load = async (unit: (typeof UNIT_NAMES)[number], file: string): Promise<void> => {
    await quietly(ctx, 'launchctl', ['bootout', launchdTarget(uid, profile, unit)]);
    await tool(ctx, 'launchctl', ['bootstrap', `gui/${uid}`, file]);
  };
  if (options.enable === true) {
    for (const [at, unit] of UNIT_NAMES.entries()) await load(unit, files[at] ?? '');
    ctx.out('loaded the dispatch agent, the listener and the watch agent');
    return;
  }
  const loaded = await Promise.all(UNIT_NAMES.map((unit) => launchdLoaded(ctx.rt, profile, unit)));
  for (const [at, unit] of UNIT_NAMES.entries()) {
    if (changed[at] !== true || loaded[at] !== true) continue;
    await load(unit, files[at] ?? '');
    ctx.out(`loaded agent-board.${profile}.${unit} again, to run the new agent file`);
  }
  if (loaded.every(Boolean)) {
    ctx.out(
      'the dispatch, listener and watch agents are loaded already; the next tick runs the new files',
    );
    return;
  }
  const pending = UNIT_NAMES.flatMap((unit, at) =>
    loaded[at] === true ? [] : [`  launchctl bootstrap gui/${uid} ${files[at] ?? ''}`],
  );
  ctx.out(`Load the agents when you are ready:\n${pending.join('\n')}`);
}

export async function runSetup(ctx: Context, options: SetupOptions): Promise<void> {
  if (ctx.inRun) throw new CliError('`board setup` cannot run inside a board run');
  const platform = requireUnitPlatform(ctx.rt, 'setup');
  const units = renderUnitFiles(ctx, platform);
  const directory = unitDirectory(ctx.rt, platform);
  if (options.print === true) {
    for (const unit of units) ctx.out(`# ${path.join(directory, unit.file)}\n${unit.text}`);
    return;
  }
  const problem = installProblem(ctx.rt);
  if (problem !== null) {
    if (options.force !== true) {
      throw new CliError(`${problem}; run \`board setup\` from the installed one, or add --force`);
    }
    ctx.out(`warning: ${problem}`);
  }
  if (platform === 'darwin') await setupLaunchd(ctx, units, options);
  else await setupSystemd(ctx, units, options);
}
