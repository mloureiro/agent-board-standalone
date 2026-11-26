import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { encodeDataKey, generateDataKey } from '@agent-board/sealing';
import { afterEach, describe, expect, it } from 'vitest';

import { loadCredentials } from '../src/profile/credentials.js';
import { renderEnvFile, renderProfileConfig, writeSecretFile } from '../src/profile/files.js';
import { keychainService, readKeychain, writeKeychain } from '../src/profile/keychain.js';
import { resolveProfileDirs } from '../src/profile/paths.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

const TOKEN = 'abm_filetoken';
const DATA_KEY = encodeDataKey(generateDataKey());

let env: TestRuntime | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function dirsOf(test: TestRuntime) {
  return resolveProfileDirs({ env: test.rt.env, homedir: test.rt.homedir }, 'work');
}

function storeEnvFile(dirs: { config: string }, mode?: number): string {
  const file = path.join(dirs.config, 'env');
  writeSecretFile(
    file,
    renderEnvFile({ AGENT_BOARD_TOKEN: TOKEN, AGENT_BOARD_DATA_KEY: DATA_KEY }),
  );
  if (mode !== undefined) chmodSync(file, mode);
  return file;
}

describe('credentials from the env file', () => {
  it('reads the token and data key', async () => {
    env = testRuntime();
    const dirs = dirsOf(env);
    storeEnvFile(dirs);
    expect(await loadCredentials(env.rt, dirs)).toEqual({
      token: TOKEN,
      dataKey: DATA_KEY,
      source: 'file',
    });
  });

  it('[cli-006] refuses a file that is not mode 600 or 400', async () => {
    env = testRuntime();
    const dirs = dirsOf(env);
    storeEnvFile(dirs, 0o644);
    await expect(loadCredentials(env.rt, dirs)).rejects.toThrow(/must be 600 or 400/);
  });

  it('says how to recover when nothing is stored', async () => {
    env = testRuntime();
    await expect(loadCredentials(env.rt, dirsOf(env))).rejects.toThrow(/board init/);
  });

  it('refuses a token without the machine prefix', async () => {
    env = testRuntime();
    const dirs = dirsOf(env);
    writeSecretFile(
      path.join(dirs.config, 'env'),
      renderEnvFile({ AGENT_BOARD_TOKEN: 'abc_nope', AGENT_BOARD_DATA_KEY: DATA_KEY }),
    );
    await expect(loadCredentials(env.rt, dirs)).rejects.toThrow(/abm_/);
  });

  it('lets process variables override the stored values', async () => {
    env = testRuntime({ env: { AGENT_BOARD_TOKEN: 'abm_override' } });
    const dirs = dirsOf(env);
    storeEnvFile(dirs);
    const credentials = await loadCredentials(env.rt, dirs);
    expect(credentials.token).toBe('abm_override');
    expect(credentials.dataKey).toBe(DATA_KEY);
  });
});

describe('credentials command', () => {
  const lines = `AGENT_BOARD_TOKEN=abm_fromcommand\nAGENT_BOARD_DATA_KEY=${DATA_KEY}\n`;

  it('[cli-007] replaces the env file entirely, even when that file is loose', async () => {
    env = testRuntime({
      env: { AGENT_BOARD_CREDENTIALS_COMMAND: '/tmp/creds' },
      exec: () => ({ code: 0, stdout: lines }),
    });
    const dirs = dirsOf(env);
    storeEnvFile(dirs, 0o644);
    const credentials = await loadCredentials(env.rt, dirs);
    expect(credentials).toEqual({ token: 'abm_fromcommand', dataKey: DATA_KEY, source: 'command' });
    expect(env.execCalls).toHaveLength(1);
    expect(env.execCalls[0]).toMatchObject({
      file: '/tmp/creds',
      args: [],
      options: { timeoutMs: 10_000, maxBytes: 64 * 1024 },
    });
  });

  it('[cli-007] never merges: a missing line is an error even if the env file has it', async () => {
    env = testRuntime({
      env: { AGENT_BOARD_CREDENTIALS_COMMAND: '/tmp/creds' },
      exec: () => ({ code: 0, stdout: 'AGENT_BOARD_TOKEN=abm_fromcommand\n' }),
    });
    const dirs = dirsOf(env);
    storeEnvFile(dirs);
    await expect(loadCredentials(env.rt, dirs)).rejects.toThrow(/no credentials/);
  });

  it('[cli-007] refuses a relative path', async () => {
    env = testRuntime({ env: { AGENT_BOARD_CREDENTIALS_COMMAND: 'creds' } });
    await expect(loadCredentials(env.rt, dirsOf(env))).rejects.toThrow(/absolute path/);
  });

  it('[cli-007] refuses a command that fails', async () => {
    env = testRuntime({
      env: { AGENT_BOARD_CREDENTIALS_COMMAND: '/tmp/creds' },
      exec: () => ({ code: 3, stdout: '' }),
    });
    await expect(loadCredentials(env.rt, dirsOf(env))).rejects.toThrow(/exited 3/);
  });
});

describe('Keychain', () => {
  it('names one service per profile', () => {
    expect(keychainService('work')).toBe('agent-board.cli.work');
  });

  it('reads both items when the profile is configured for it', async () => {
    env = testRuntime({
      platform: 'darwin',
      exec: (_file, args) => ({
        code: 0,
        stdout: `${args.includes('token') ? 'abm_keychain' : DATA_KEY}\n`,
      }),
    });
    const dirs = dirsOf(env);
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(
      path.join(dirs.config, 'config.yaml'),
      renderProfileConfig({ credentials: 'keychain' }),
    );
    const credentials = await loadCredentials(env.rt, dirs);
    expect(credentials).toEqual({ token: 'abm_keychain', dataKey: DATA_KEY, source: 'keychain' });
    expect(env.execCalls.map((call) => call.args)).toEqual([
      ['find-generic-password', '-s', 'agent-board.cli.work', '-a', 'token', '-w'],
      ['find-generic-password', '-s', 'agent-board.cli.work', '-a', 'data-key', '-w'],
    ]);
  });

  it('reports a missing item as null', async () => {
    env = testRuntime({ platform: 'darwin', exec: () => ({ code: 44, stdout: '' }) });
    expect(await readKeychain(env.rt, 'work', 'token')).toBeNull();
  });

  it('writes through standard input so the secret never appears in the arguments', async () => {
    env = testRuntime({ platform: 'darwin', exec: () => ({ code: 0, stdout: '' }) });
    await writeKeychain(env.rt, 'work', 'token', 'abm_secret');
    const [call] = env.execCalls;
    expect(call?.args).toEqual(['-i']);
    expect(call?.options.stdin).toContain('-s agent-board.cli.work -a token -w abm_secret');
  });

  it('refuses outside macOS', async () => {
    env = testRuntime({ platform: 'linux' });
    await expect(readKeychain(env.rt, 'work', 'token')).rejects.toThrow(/only available on macOS/);
  });
});
