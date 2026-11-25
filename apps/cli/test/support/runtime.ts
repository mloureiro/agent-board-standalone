import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExecOptions, ExecResult, Runtime } from '../../src/runtime.js';

export interface Captured {
  stdout: string;
  stderr: string;
}

export interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions;
}

export interface TestRuntime {
  readonly rt: Runtime;
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
}

export function testRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const root = mkdtempSync(path.join(os.tmpdir(), 'board-cli-test-'));
  const captured: Captured = { stdout: '', stderr: '' };
  const execCalls: ExecCall[] = [];
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
    root,
    path: (...segments) => path.join(root, ...segments),
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
