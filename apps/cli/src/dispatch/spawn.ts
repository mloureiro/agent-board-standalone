import path from 'node:path';

import { PASSED_VARIABLES, WORKER_INHERITED_VARIABLES } from '@agent-board/contract';

import { CliError } from '../errors.js';
import { logDirectory, findProgram } from '../units/layout.js';
import type { Context } from '../commands/context.js';

export const WORKER_SPAWN_VARIABLE = 'AGENT_BOARD_WORKER_SPAWN';

export type WorkerVia = 'unit' | 'process';

export interface StartedWorker {
  readonly via: WorkerVia;
  readonly pid: number | null;
  readonly unit: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

export function workerLogFile(ctx: Pick<Context, 'dirs'>, task: string): string {
  return path.join(logDirectory(ctx.dirs), `${task}.log`);
}

export function workerUnitName(profile: string, task: string): string {
  return `agent-board-${profile}-task-${task}`;
}

export function selfCommand(ctx: Pick<Context, 'rt' | 'dirs'>, ...args: string[]): string[] {
  const [program = '', ...leading] = ctx.rt.self;
  return [program, ...leading, '--profile', ctx.dirs.profile, ...args];
}

export function workerCommand(ctx: Pick<Context, 'rt' | 'dirs'>, task: string): string[] {
  return selfCommand(ctx, 'internal', 'worker', task);
}

function unitEnvironment(env: Env): Record<string, string> {
  const names = new Set<string>([
    'PATH',
    ...WORKER_INHERITED_VARIABLES,
    ...PASSED_VARIABLES,
    ...Object.keys(env).filter((name) => name.startsWith('AGENT_BOARD_')),
  ]);
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') values[name] = value;
  }
  return values;
}

function processEnvironment(env: Env): Record<string, string | undefined> {
  const rest = { ...env };
  delete rest.AGENT_BOARD_TASK;
  delete rest.AGENT_BOARD_RUN;
  return rest;
}

export function wantsUnit(ctx: Pick<Context, 'rt'>): boolean {
  return (
    ctx.rt.env[WORKER_SPAWN_VARIABLE] !== 'process' &&
    ctx.rt.platform === 'linux' &&
    findProgram(ctx.rt, 'systemd-run') !== undefined
  );
}

export async function startWorker(
  ctx: Pick<Context, 'rt' | 'dirs'>,
  task: string,
): Promise<StartedWorker> {
  const [program = '', ...args] = workerCommand(ctx, task);
  if (wantsUnit(ctx)) {
    const unit = workerUnitName(ctx.dirs.profile, task);
    const setenv = Object.entries(unitEnvironment(ctx.rt.env)).map(
      ([name, value]) => `--setenv=${name}=${value}`,
    );
    const result = await ctx.rt.exec(
      'systemd-run',
      ['--user', '--collect', '--quiet', `--unit=${unit}`, ...setenv, program, ...args],
      { timeoutMs: 20_000, maxBytes: 64 * 1024 },
    );
    if (result.code !== 0) {
      throw new CliError(`systemd-run could not start ${unit} (exit ${result.code})`);
    }
    return { via: 'unit', pid: null, unit };
  }
  const pid = ctx.rt.spawnDetached(program, args, {
    env: processEnvironment(ctx.rt.env),
    logFile: workerLogFile(ctx, task),
  });
  return { via: 'process', pid, unit: null };
}
