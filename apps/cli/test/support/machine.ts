import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

import { runCli } from '../../src/commands/program.js';
import type { ExecResult, Runtime } from '../../src/runtime.js';
import { testRuntime, type TestRuntime, type TestRuntimeOptions } from './runtime.js';

export interface UpdateMachine {
  readonly test: TestRuntime;
  readonly binary: string;
  readonly rt: Runtime;
  readonly config: string;
  readonly state: string;
  run(...args: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  binaryText(): string;
}

export interface UpdateMachineOptions extends Omit<TestRuntimeOptions, 'self'> {
  readonly releasesUrl?: string;
  readonly script?: boolean;
  readonly reportedVersion?: string;
}

export function useUpdateMachine(): (options?: UpdateMachineOptions) => UpdateMachine {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  return (options = {}) => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'rumo-cli-bin-'));
    const binary = path.join(bin, 'rumo');
    writeFileSync(binary, 'the old binary', { mode: 0o755 });
    const probe = (file: string): ExecResult => ({
      code: 0,
      stdout: `rumo ${options.reportedVersion ?? readFileSync(file, 'utf8').replace(/^\D+/, '')} (contract 1)\n`,
    });
    const test = testRuntime({
      ...options,
      self: options.script === true ? [binary, 'script.js'] : [binary],
      env: {
        ...(options.releasesUrl === undefined ? {} : { RUMO_RELEASES_URL: options.releasesUrl }),
        ...options.env,
      },
      exec: options.exec ?? ((file) => probe(file)),
    });
    cleanups.push(() => {
      test.dispose();
      rmSync(bin, { recursive: true, force: true });
    });
    const config = test.path('config');
    const state = test.path('state');
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'config.yaml'), 'machine: test-machine\n');
    return {
      test,
      binary,
      rt: test.rt,
      config,
      state,
      run: (...args) => runCli(args, test.rt),
      stdout: () => test.captured.stdout,
      stderr: () => test.captured.stderr,
      binaryText: () => readFileSync(binary, 'utf8'),
    };
  };
}
