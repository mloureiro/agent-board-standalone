import path from 'node:path';

import { partPath, STUBS_DIR } from './paths.js';
import { launch, runProcess, terminate, type RunResult } from './run.js';
import type { Tmp } from './tmp.js';

export type ProfileMode = 'overrides' | 'profile';

export interface CliBoard {
  readonly tmp: Tmp;
}

export interface CliOptions {
  readonly board: CliBoard;
  readonly profileMode?: ProfileMode;
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export function cliEnv(
  board: CliBoard,
  options: { profileMode?: ProfileMode; env?: Readonly<Record<string, string>> } = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const { tmp } = board;
  const env: Record<string, string> = {
    HOME: tmp.home,
    PATH: [STUBS_DIR, baseEnv.PATH ?? ''].filter(Boolean).join(path.delimiter),
    RUMO_WORKER_SPAWN: 'process',
    RUMO_E2E: '1',
    RUMO_CLOCK_OFFSET_FILE: tmp.clockFile,
  };
  if (options.profileMode === 'profile') {
    env.XDG_CONFIG_HOME = tmp.path('xdg', 'config');
    env.XDG_STATE_HOME = tmp.path('xdg', 'state');
  } else {
    env.RUMO_CONFIG_DIR = tmp.path('cli', 'config');
    env.RUMO_STATE_DIR = tmp.path('cli', 'state');
    env.RUMO_RUN_DIR = tmp.path('cli', 'run');
  }
  return { ...env, ...options.env };
}

export function runCli(args: readonly string[], options: CliOptions): Promise<RunResult> {
  return runProcess(partPath('cli'), args, {
    env: cliEnv(options.board, options),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}

export interface RunningCli {
  readonly output: { stdout: string; stderr: string };
  write(text: string): void;
  stop(): Promise<RunResult>;
  readonly exited: Promise<RunResult>;
}

export function startCli(args: readonly string[], options: CliOptions): RunningCli {
  const running = launch(partPath('cli'), args, { env: cliEnv(options.board, options) });
  if (options.stdin !== undefined) running.child.stdin?.write(options.stdin);
  return {
    output: running.output,
    exited: running.exited,
    write: (text) => {
      running.child.stdin?.write(text);
    },
    stop: () => terminate(running),
  };
}
