import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSecretFile,
  backupFile,
  parseEnvFile,
  readProfileConfig,
  readServerFile,
  renderEnvFile,
  renderProfileConfig,
  writeSecretFile,
  writeServerFile,
} from '../src/profile/files.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

let env: TestRuntime | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
});

function fresh(): TestRuntime {
  env = testRuntime();
  return env;
}

describe('env file', () => {
  it('round-trips the credential lines', () => {
    const text = renderEnvFile({ RUMO_TOKEN: 'abm_x', RUMO_DATA_KEY: 'abk1_y' });
    expect(parseEnvFile(text)).toEqual({
      RUMO_TOKEN: 'abm_x',
      RUMO_DATA_KEY: 'abk1_y',
    });
  });

  it('skips blanks and comments and strips quotes', () => {
    expect(parseEnvFile('# c\n\nA="1"\nB=\'2\'\nnoequals\n=x\nC = 3 \n')).toEqual({
      A: '1',
      B: '2',
      C: '3',
    });
  });
});

describe('secret file modes', () => {
  it.each([0o600, 0o400])('[cli-006] accepts mode %o', (mode) => {
    const { path: at } = fresh();
    const file = at('secret');
    writeFileSync(file, 'x');
    chmodSync(file, mode);
    expect(() => assertSecretFile(file, 'the file')).not.toThrow();
  });

  it.each([0o644, 0o640, 0o660, 0o700, 0o604])('[cli-006] refuses mode %o', (mode) => {
    const { path: at } = fresh();
    const file = at('secret');
    writeFileSync(file, 'x');
    chmodSync(file, mode);
    expect(() => assertSecretFile(file, 'the file')).toThrow(/must be 600 or 400/);
  });

  it('writes secrets with mode 600 even under a permissive umask', () => {
    const { path: at } = fresh();
    const previous = process.umask(0);
    try {
      writeSecretFile(at('nested', 'env'), 'A=1\n');
    } finally {
      process.umask(previous);
    }
    expect(statSync(at('nested', 'env')).mode & 0o777).toBe(0o600);
  });
});

describe('server and config files', () => {
  it('reads back what it wrote and treats a missing file as absent', () => {
    const { path: at } = fresh();
    expect(readServerFile(at('config'))).toBeNull();
    writeServerFile(at('config'), { url: 'http://localhost:1' });
    expect(readServerFile(at('config'))).toEqual({ url: 'http://localhost:1' });
  });

  it('refuses a server file without a url', () => {
    const { path: at } = fresh();
    mkdirSync(at('config'));
    writeFileSync(at('config', 'server.json'), '{}');
    expect(() => readServerFile(at('config'))).toThrow(/no "url"/);
  });

  it('keeps the machine name and credential store in config.yaml', () => {
    const { path: at } = fresh();
    mkdirSync(at('config'));
    writeFileSync(
      at('config', 'config.yaml'),
      renderProfileConfig({ machine: 'm1', credentials: 'keychain' }),
    );
    expect(readProfileConfig(at('config'))).toEqual({ machine: 'm1', credentials: 'keychain' });
    expect(readProfileConfig(at('missing'))).toEqual({});
  });
});

describe('secret file staging', () => {
  it('[cli-006] never writes through a link planted at the old fixed staging name', () => {
    const { path: at } = fresh();
    const file = at('env');
    const stolen = at('stolen');
    writeFileSync(stolen, '');
    symlinkSync(stolen, `${file}.tmp-${process.pid}`);
    writeSecretFile(file, 'RUMO_TOKEN=secret\n');
    expect(readFileSync(file, 'utf8')).toBe('RUMO_TOKEN=secret\n');
    expect(readFileSync(stolen, 'utf8')).toBe('');
  });
});

describe('backups', () => {
  it('copies a file with its mode and returns null when there is nothing to copy', () => {
    const { path: at } = fresh();
    const file = at('env');
    expect(backupFile(file, '1')).toBeNull();
    writeSecretFile(file, 'A=1\n');
    const backup = backupFile(file, '20260101T000000');
    expect(backup).toBe(`${file}.bak-20260101T000000`);
    expect(readFileSync(backup ?? '', 'utf8')).toBe('A=1\n');
    expect(path.basename(backup ?? '')).toContain('env');
    expect(statSync(backup ?? '').mode & 0o777).toBe(0o600);
  });
});
