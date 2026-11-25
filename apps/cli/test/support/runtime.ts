import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExecOptions, ExecResult, InteractiveOptions, Runtime } from '../../src/runtime.js';

export interface Captured {
  stdout: string;
  stderr: string;
}

export interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

export interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: InteractiveOptions;
}

export interface TestRuntime {
  readonly rt: Runtime;
  readonly spawnCalls: SpawnCall[];
  readonly captured: Captured;
  readonly execCalls: ExecCall[];
  readonly root: string;
  path(...segments: string[]): string;
  dispose(): void;
}

export interface TestRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly fetch?: typeof fetch;
  readonly exec?: (file: string, args: readonly string[], options: ExecOptions) => ExecResult;
  readonly overrideDirs?: boolean;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly interrupt?: AbortSignal;
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: InteractiveOptions,
  ) => number | Promise<number>;
}

export function testRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const root = mkdtempSync(path.join(os.tmpdir(), 'board-cli-test-'));
  const captured: Captured = { stdout: '', stderr: '' };
  const execCalls: ExecCall[] = [];
  const spawnCalls: SpawnCall[] = [];
  const dirEnv =
    options.overrideDirs === false
      ? {
          XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
          XDG_STATE_HOME: path.join(root, 'xdg-state'),
        }
      : {
          AGENT_BOARD_CONFIG_DIR: path.join(root, 'config'),
          AGENT_BOARD_STATE_DIR: path.join(root, 'state'),
          AGENT_BOARD_RUN_DIR: path.join(root, 'run'),
        };
  const rt: Runtime = {
    env: { ...dirEnv, ...options.env },
    interrupt: options.interrupt ?? new AbortController().signal,
    cwd: () => options.cwd ?? root,
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    spawnInteractive: (file, args, spawnOptions) => {
      spawnCalls.push({ file, args, options: spawnOptions });
      return Promise.resolve(options.spawn?.(file, args, spawnOptions) ?? 0);
    },
    io: {
      stdout: (text) => {
        captured.stdout += text;
      },
      stderr: (text) => {
        captured.stderr += text;
      },
      stdoutIsTty: false,
      stderrIsTty: false,
    },
    fetch: options.fetch ?? globalThis.fetch,
    platform: options.platform ?? 'linux',
    homedir: path.join(root, 'home'),
    hostname: 'test-host',
    exec: (file, args, execOptions) => {
      execCalls.push({ file, args, options: execOptions });
      const handler = options.exec;
      if (handler === undefined) return Promise.reject(new Error('exec is not available'));
      return Promise.resolve(handler(file, args, execOptions));
    },
  };
  return {
    rt,
    captured,
    execCalls,
    spawnCalls,
    root,
    path: (...segments) => path.join(root, ...segments),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
