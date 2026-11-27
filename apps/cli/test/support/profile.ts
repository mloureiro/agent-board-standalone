import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runCli } from '../../src/commands/program.js';
import { TEST_TOKEN } from './board.js';
import { testRuntime, type TestRuntime, type TestRuntimeOptions } from './runtime.js';
import type { ApiStub } from './api-stub.js';

export interface Cli {
  readonly test: TestRuntime;
  run(...args: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  reset(): void;
}

export interface ProfileOptions extends TestRuntimeOptions {
  readonly config?: string;
}

export function cliFor(stub: ApiStub, options: ProfileOptions = {}): Cli {
  const test = testRuntime({ platform: process.platform, ...options });
  const config =
    options.overrideDirs === false
      ? test.path('xdg-config', 'rumo', 'profiles', 'default')
      : test.path('config');
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, 'server.json'), JSON.stringify({ url: stub.url }));
  const env = path.join(config, 'env');
  writeFileSync(env, `RUMO_TOKEN=${TEST_TOKEN}\nRUMO_DATA_KEY=${stub.dataKey}\n`);
  chmodSync(env, 0o600);
  writeFileSync(path.join(config, 'config.yaml'), options.config ?? 'machine: test-machine\n');
  return {
    test,
    run: (...args) => runCli(args, test.rt),
    stdout: () => test.captured.stdout,
    stderr: () => test.captured.stderr,
    reset: () => {
      test.captured.stdout = '';
      test.captured.stderr = '';
    },
  };
}
