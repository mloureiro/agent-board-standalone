import { existsSync } from 'node:fs';
import path from 'node:path';

import { taskId } from '@agent-board/contract';

import type { Context } from '../commands/context.js';
import { CliError, ReportedFailure, UsageError } from '../errors.js';
import {
  launchdLoaded,
  launchdTarget,
  logDirectory,
  requireUnitPlatform,
  runTool,
  unitDirectory,
} from './layout.js';
import {
  isUnitName,
  launchdFile,
  launchdLabel,
  launchdLogFile,
  restartedSystemdUnit,
  systemdService,
  UNIT_NAMES,
  type UnitName,
} from './names.js';

export const DEFAULT_LINES = '100';

const SETUP_HINT = 'run `board setup --enable`';

function selected(requested: readonly string[]): UnitName[] {
  const names = requested.filter(isUnitName);
  return names.length === 0 ? [...UNIT_NAMES] : UNIT_NAMES.filter((unit) => names.includes(unit));
}

export async function runRestart(ctx: Context, requested: readonly string[]): Promise<void> {
  if (ctx.inRun) throw new CliError('`board restart` cannot run inside a board run');
  const platform = requireUnitPlatform(ctx.rt, 'restart');
  const directory = unitDirectory(ctx.rt, platform);
  const { profile } = ctx.dirs;
  let restarted = 0;
  let failed = false;
  for (const unit of selected(requested)) {
    let program: string;
    let args: string[];
    let name: string;
    let verb = 'restarted';
    if (platform === 'linux') {
      name = restartedSystemdUnit(profile, unit);
      if (!existsSync(path.join(directory, name))) {
        ctx.out(`${name} is not installed in ${directory}; ${SETUP_HINT}`);
        continue;
      }
      program = 'systemctl';
      args = ['--user', 'restart', name];
    } else {
      name = launchdLabel(profile, unit);
      if (!(await launchdLoaded(ctx.rt, profile, unit))) {
        ctx.out(
          `${name} is not loaded; ${SETUP_HINT}, or load it with: launchctl bootstrap gui/${ctx.rt.uid} ${path.join(directory, launchdFile(profile, unit))}`,
        );
        continue;
      }
      program = 'launchctl';
      args = [
        'kickstart',
        ...(unit === 'dispatch' ? [] : ['-k']),
        launchdTarget(ctx.rt.uid, profile, unit),
      ];
      if (unit === 'dispatch') verb = 'started a tick of';
    }
    if (ctx.dryRun) {
      ctx.out(`DRY ${program} ${args.join(' ')}`);
      restarted += 1;
      continue;
    }
    const result = await runTool(ctx.rt, program, args);
    if (result.code === 0) {
      ctx.out(`${verb} ${name}`);
      restarted += 1;
    } else {
      failed = true;
      ctx.out(`could not restart ${name}: ${program} exited ${result.code}`);
    }
  }
  if (failed) throw new ReportedFailure(1, 'a restart failed');
  if (restarted === 0) throw new ReportedFailure(1, 'nothing was restarted');
}

export interface LogsOptions {
  readonly follow?: boolean;
  readonly lines: string;
  readonly since?: string;
}

function lineCount(text: string): string {
  if (!/^[1-9][0-9]{0,6}$/.test(text))
    throw new UsageError('--lines takes a positive whole number');
  return text;
}

function sinceTime(text: string): string {
  if (!/^[A-Za-z0-9 :.+_-]{1,40}$/.test(text)) {
    throw new UsageError('--since takes a time such as "1 hour ago", "-30m" or "2026-01-31 10:00"');
  }
  return text;
}

function tailArguments(count: string, follow: boolean, files: readonly string[]): string[] {
  for (const file of files) {
    if (!existsSync(file)) throw new CliError(`no log yet: ${file} does not exist`);
  }
  return ['tail', '-n', count, ...(follow ? ['-f'] : []), ...files];
}

export function logsCommand(
  ctx: Context,
  target: string | undefined,
  options: LogsOptions,
): string[] {
  const platform = requireUnitPlatform(ctx.rt, 'logs');
  const count = lineCount(options.lines);
  const follow = options.follow === true;
  const isTask = target !== undefined && !isUnitName(target);
  if (options.since !== undefined && (isTask || platform !== 'linux')) {
    throw new UsageError(
      '--since works for the units on Linux only; use --lines for the end of a log',
    );
  }
  if (isTask) {
    if (!taskId.safeParse(target).success) {
      throw new UsageError(`"${target.slice(0, 40)}" is not ${UNIT_NAMES.join(', ')} or a task id`);
    }
    return tailArguments(count, follow, [path.join(logDirectory(ctx.dirs), `${target}.log`)]);
  }
  const units = selected(target === undefined ? [] : [target]);
  if (platform === 'linux') {
    return [
      'journalctl',
      '--user',
      '--no-pager',
      '-n',
      count,
      ...(follow ? ['-f'] : []),
      ...(options.since === undefined ? [] : [`--since=${sinceTime(options.since)}`]),
      ...units.flatMap((unit) => ['-u', systemdService(ctx.dirs.profile, unit)]),
    ];
  }
  return tailArguments(
    count,
    follow,
    units.map((unit) => path.join(logDirectory(ctx.dirs), launchdLogFile(unit))),
  );
}

export async function runLogs(
  ctx: Context,
  target: string | undefined,
  options: LogsOptions,
): Promise<void> {
  const [program = '', ...args] = logsCommand(ctx, target, options);
  const code = await ctx.rt
    .spawnInteractive(program, args, { cwd: ctx.rt.cwd() })
    .catch(() => null);
  if (code === null) throw new CliError(`could not start ${program}`);
  if (code !== 0 && !(options.follow === true && code === 130)) {
    throw new ReportedFailure(code, `${program} ended with status ${code}`);
  }
}
