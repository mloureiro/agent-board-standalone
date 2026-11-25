import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Prompter } from '../../src/input/prompter.js';
import type {
  DetachedOptions,
  ExecOptions,
  ExecResult,
  InteractiveOptions,
  Runtime,
} from '../../src/runtime.js';

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

export interface DetachedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: DetachedOptions;
}

export interface TestRuntime {
  readonly rt: Runtime;
  readonly spawnCalls: SpawnCall[];
  readonly detachedCalls: DetachedCall[];
  readonly captured: Captured;
  readonly asked: string[];
  readonly execCalls: ExecCall[];
  readonly root: string;
  path(...segments: string[]): string;
  dispose(): void;
}

export interface TestRuntimeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly fetch?: typeof fetch;
  readonly exec?: (
    file: string,
    args: readonly string[],
    options: ExecOptions,
  ) => ExecResult | Promise<ExecResult>;
  readonly overrideDirs?: boolean;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly answers?: readonly string[];
  readonly prompts?: {
    readonly text?: readonly (string | null)[];
    readonly secret?: readonly (string | null)[];
    readonly confirm?: readonly (boolean | null)[];
  };
  readonly self?: readonly string[];
  readonly tty?: boolean;
  readonly interrupt?: AbortSignal;
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: InteractiveOptions,
  ) => number | Promise<number>;
  readonly spawnDetached?: (
    file: string,
    args: readonly string[],
    options: DetachedOptions,
  ) => number | null;
}

export function testRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const root = mkdtempSync(path.join(os.tmpdir(), 'board-cli-test-'));
  const captured: Captured = { stdout: '', stderr: '' };
  const execCalls: ExecCall[] = [];
  const spawnCalls: SpawnCall[] = [];
  const detachedCalls: DetachedCall[] = [];
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
  const pending = [...(options.answers ?? [])];
  const queued = {
    text: [...(options.prompts?.text ?? [])],
    secret: [...(options.prompts?.secret ?? [])],
    confirm: [...(options.prompts?.confirm ?? [])],
  };
  const asked: string[] = [];
  const prompter: Prompter | null =
    options.prompts === undefined
      ? null
      : {
          text: (message) => {
            asked.push(message);
            return Promise.resolve(queued.text.shift() ?? null);
          },
          secret: (message) => {
            asked.push(message);
            return Promise.resolve(queued.secret.shift() ?? null);
          },
          confirm: (message) => {
            asked.push(message);
            return Promise.resolve(queued.confirm.shift() ?? null);
          },
        };
  const rt: Runtime = {
    env: { ...dirEnv, ...options.env },
    interrupt: options.interrupt ?? new AbortController().signal,
    cwd: () => options.cwd ?? root,
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    ask: (question) => {
      captured.stderr += question;
      return Promise.resolve(pending.shift() ?? null);
    },
    spawnInteractive: (file, args, spawnOptions) => {
      spawnCalls.push({ file, args, options: spawnOptions });
      return Promise.resolve(options.spawn?.(file, args, spawnOptions) ?? 0);
    },
    spawnDetached: (file, args, detachedOptions) => {
      detachedCalls.push({ file, args, options: detachedOptions });
      return options.spawnDetached?.(file, args, detachedOptions) ?? 4242;
    },
    io: {
      stdout: (text) => {
        captured.stdout += text;
      },
      stderr: (text) => {
        captured.stderr += text;
      },
      stdoutIsTty: options.tty === true,
      stderrIsTty: false,
    },
    fetch: options.fetch ?? globalThis.fetch,
    platform: options.platform ?? 'linux',
    arch: options.arch ?? 'x64',
    homedir: path.join(root, 'home'),
    hostname: 'test-host',
    uid: 501,
    self: options.self ?? ['/opt/board/bin/board'],
    prompts: prompter,
    exec: (file, args, execOptions) => {
      execCalls.push({ file, args, options: execOptions });
      const handler = options.exec;
      if (handler === undefined) return Promise.reject(new Error('exec is not available'));
      return Promise.resolve(handler(file, args, execOptions));
    },
  };
  return {
    rt,
    asked,
    captured,
    execCalls,
    spawnCalls,
    detachedCalls,
    root,
    path: (...segments) => path.join(root, ...segments),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
