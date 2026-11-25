import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/commands/program.js';
import { CliError, EXIT, ReportedFailure, UsageError } from '../src/errors.js';
import { startBoard, MACHINE, TEST_TOKEN, type FakeBoard } from './support/board.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

const stoppers: (() => Promise<void>)[] = [];
let env: TestRuntime | undefined;

afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  env?.dispose();
  env = undefined;
});

async function board(options: Parameters<typeof startBoard>[0] = {}): Promise<FakeBoard> {
  const started = await startBoard(options);
  stoppers.push(() => started.stop());
  return started;
}

function runtime(options: Parameters<typeof testRuntime>[0] = {}): TestRuntime {
  env = testRuntime(options);
  return env;
}

function secrets(test: TestRuntime, board_: FakeBoard, mode = 0o600) {
  const tokenFile = test.path('secrets', 'token');
  const dataKeyFile = test.path('secrets', 'data-key');
  for (const [file, content] of [
    [tokenFile, TEST_TOKEN],
    [dataKeyFile, board_.dataKey],
  ] as const) {
    writeSecret(file, content, mode);
  }
  return { tokenFile, dataKeyFile };
}

function writeSecret(file: string, content: string, mode: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${content}\n`, { mode });
  chmodSync(file, mode);
}

function initArgs(
  url: string,
  files: { tokenFile: string; dataKeyFile: string },
  extra: string[] = [],
) {
  return [
    'init',
    '--url',
    url,
    '--token-file',
    files.tokenFile,
    '--data-key-file',
    files.dataKeyFile,
    ...extra,
  ];
}

function listing(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

describe('exit codes', () => {
  it('defines the documented codes', () => {
    expect(EXIT).toEqual({
      ok: 0,
      failure: 1,
      usage: 2,
      expectMismatch: 3,
      lockHeld: 75,
      timedOut: 124,
    });
  });

  it('exits 2 on a usage error and writes board: <message>', async () => {
    const test = runtime();
    expect(await runCli(['nosuch'], test.rt)).toBe(2);
    expect(test.captured.stderr).toMatch(/^board: unknown command 'nosuch'/);
    expect(await runCli(['version', '--nosuch'], test.rt)).toBe(2);
    expect(await runCli(['init'], test.rt)).toBe(2);
  });

  it('exits 2 for an invalid profile name', async () => {
    const test = runtime();
    expect(await runCli(['--profile', 'Bad_Name', 'version'], test.rt)).toBe(2);
    expect(test.captured.stderr).toMatch(/invalid profile name/);
  });

  it('exits 1 with board: <message> for any other failure', async () => {
    const test = runtime();
    expect(
      await runCli(
        [
          'init',
          '--url',
          'http://127.0.0.1:1',
          '--token-file',
          '/tmp/none',
          '--data-key-file',
          '/tmp/none',
        ],
        test.rt,
      ),
    ).toBe(1);
    expect(test.captured.stderr).toMatch(/^board: token file \/tmp\/none does not exist\n$/);
  });

  it('keeps the code of a reported failure and of a usage error', async () => {
    expect(new ReportedFailure(3).exitCode).toBe(3);
    expect(new UsageError('x').exitCode).toBe(2);
    expect(new CliError('x').exitCode).toBe(1);
  });

  it('prints help and exits 0 for --help, --version and a bare board', async () => {
    const test = runtime();
    expect(await runCli(['--help'], test.rt)).toBe(0);
    expect(await runCli(['--version'], test.rt)).toBe(0);
    expect(await runCli([], test.rt)).toBe(0);
    expect(test.captured.stdout).toContain('Usage: board');
    expect(test.captured.stdout).toMatch(/board 0\.0\.0 \(contract 1\)/);
  });
});

describe('board version', () => {
  it('prints only the CLI facts when no server is configured', async () => {
    const test = runtime();
    expect(await runCli(['version'], test.rt)).toBe(0);
    expect(test.captured.stdout).toMatch(/server: not configured/);
  });

  it('reports the verdict, the server URL and every feature', async () => {
    const server = await board();
    const test = runtime();
    expect(await runCli(initArgs(server.url, secrets(test, server)), test.rt)).toBe(0);
    test.captured.stdout = '';
    expect(await runCli(['version'], test.rt)).toBe(0);
    expect(test.captured.stdout).toContain(server.url);
    expect(test.captured.stdout).toMatch(/verdict: compatible/);
    expect(test.captured.stdout).toContain('watches');
  });

  it('exits 0 and says the CLI is too old when the server needs a newer contract', async () => {
    const server = await board({ contract: 2, minClient: 2 });
    const test = runtime();
    mkdirSync(test.path('config'), { recursive: true });
    writeFileSync(test.path('config', 'server.json'), JSON.stringify({ url: server.url }));
    expect(await runCli(['version', '--json'], test.rt)).toBe(0);
    const report = JSON.parse(test.captured.stdout) as {
      verdict: string;
      server: { contract: number };
    };
    expect(report.verdict).toBe('client-too-old');
    expect(report.server.contract).toBe(2);
  });
});

describe('board init', () => {
  it('writes server.json, env with mode 600 and config.yaml, taking the machine name from the server', async () => {
    const server = await board();
    const test = runtime();
    expect(await runCli(initArgs(server.url, secrets(test, server)), test.rt)).toBe(0);
    const config = test.path('config');
    expect(listing(config)).toEqual(['config.yaml', 'env', 'server.json']);
    expect(statSync(path.join(config, 'env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(config, 'env'), 'utf8')).toContain(TEST_TOKEN);
    expect(JSON.parse(readFileSync(path.join(config, 'server.json'), 'utf8'))).toEqual({
      url: server.url,
    });
    expect(readFileSync(path.join(config, 'config.yaml'), 'utf8')).toContain(MACHINE);
    expect(existsSync(test.path('state'))).toBe(true);
  });

  it('writes nothing for a refused token, data key or file mode', async () => {
    const server = await board();
    const otherKey = (await board()).dataKey;
    const test = runtime();
    const good = secrets(test, server);
    writeSecret(good.dataKeyFile, otherKey, 0o600);
    expect(await runCli(initArgs(server.url, good), test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/key id .* does not match/);

    writeSecret(good.dataKeyFile, server.dataKey, 0o600);
    writeSecret(good.tokenFile, 'abm_wrong', 0o600);
    expect(await runCli(initArgs(server.url, good), test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/401 unauthorized/);

    writeSecret(good.tokenFile, TEST_TOKEN, 0o644);
    expect(await runCli(initArgs(server.url, good), test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/must be 600 or 400/);

    expect(existsSync(test.path('config'))).toBe(false);
    expect(existsSync(test.path('state'))).toBe(false);
  });

  it('refuses an existing setup without --force and keeps backups with it', async () => {
    const server = await board();
    const test = runtime();
    const files = secrets(test, server);
    expect(await runCli(initArgs(server.url, files), test.rt)).toBe(0);
    const before = readFileSync(test.path('config', 'env'), 'utf8');
    expect(await runCli(initArgs(server.url, files), test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/already initialised/);

    writeFileSync(test.path('config', 'config.yaml'), '# edited\n');
    expect(await runCli(initArgs(server.url, files, ['--force']), test.rt)).toBe(0);
    const backups = listing(test.path('config')).filter((name) => name.includes('.bak-'));
    expect(backups).toHaveLength(2);
    const envBackup = backups.find((name) => name.startsWith('env'));
    expect(readFileSync(test.path('config', envBackup ?? ''), 'utf8')).toBe(before);
    expect(readFileSync(test.path('config', 'config.yaml'), 'utf8')).toBe('# edited\n');
  });

  it('checks --machine against the name the server reports', async () => {
    const server = await board();
    const test = runtime();
    const files = secrets(test, server);
    expect(await runCli(initArgs(server.url, files, ['--machine', 'other']), test.rt)).toBe(1);
    expect(test.captured.stderr).toContain(MACHINE);
    expect(existsSync(test.path('config'))).toBe(false);
    expect(await runCli(initArgs(server.url, files, ['--machine', MACHINE]), test.rt)).toBe(0);
  });

  it('refuses a non-local http URL and a URL with credentials', async () => {
    const test = runtime();
    const files = { tokenFile: '/tmp/none', dataKeyFile: '/tmp/none' };
    expect(await runCli(initArgs('http://example.org', files), test.rt)).toBe(2);
    expect(await runCli(initArgs('https://user:pw@example.org', files), test.rt)).toBe(2);
    expect(await runCli(initArgs('not a url', files), test.rt)).toBe(2);
  });

  it('prints DRY and writes nothing under --dry-run, before or after the command', async () => {
    const server = await board();
    const test = runtime();
    const files = secrets(test, server);
    expect(await runCli(['--dry-run', ...initArgs(server.url, files)], test.rt)).toBe(0);
    expect(await runCli([...initArgs(server.url, files), '--dry-run'], test.rt)).toBe(0);
    expect(test.captured.stdout.match(/^DRY init$/gm)).toHaveLength(2);
    expect(existsSync(test.path('config'))).toBe(false);
  });

  it('generates, registers and stores a signing key when the server requires signatures', async () => {
    const server = await board({ requestSignature: true });
    const test = runtime();
    expect(await runCli(initArgs(server.url, secrets(test, server)), test.rt)).toBe(0);
    const keyFile = test.path('config', 'signing-key.jwk');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const registered = server.seen.find((entry) => entry.path === '/api/machine/register-key');
    expect(JSON.parse(registered?.body ?? '{}')).toMatchObject({ label: 'test-host' });
    const handshake = server.seen.filter((entry) => entry.path === '/api/machine/version');
    expect(handshake.at(-1)?.headers['x-board-sig']).toBeDefined();
  });

  it('does not generate a key when the server does not require signatures', async () => {
    const server = await board();
    const test = runtime();
    expect(await runCli(initArgs(server.url, secrets(test, server)), test.rt)).toBe(0);
    expect(existsSync(test.path('config', 'signing-key.jwk'))).toBe(false);
    expect(server.seen.some((entry) => entry.path === '/api/machine/register-key')).toBe(false);
  });

  it('does not register a key under --dry-run', async () => {
    const server = await board({ requestSignature: true });
    const test = runtime();
    expect(
      await runCli(['--dry-run', ...initArgs(server.url, secrets(test, server))], test.rt),
    ).toBe(0);
    expect(server.seen.some((entry) => entry.path === '/api/machine/register-key')).toBe(false);
    expect(test.captured.stdout).toContain('DRY register-key');
    expect(test.captured.stdout).toContain('DRY init');
    expect(existsSync(test.path('config'))).toBe(false);
  });

  it('refuses --keychain outside macOS', async () => {
    const server = await board();
    const test = runtime();
    expect(await runCli(initArgs(server.url, secrets(test, server), ['--keychain']), test.rt)).toBe(
      2,
    );
  });

  it('keeps credentials in the Keychain with --keychain on macOS', async () => {
    const server = await board();
    const test = runtime({ platform: 'darwin', exec: () => ({ code: 0, stdout: '' }) });
    expect(await runCli(initArgs(server.url, secrets(test, server), ['--keychain']), test.rt)).toBe(
      0,
    );
    expect(existsSync(test.path('config', 'env'))).toBe(false);
    expect(readFileSync(test.path('config', 'config.yaml'), 'utf8')).toContain(
      'credentials: keychain',
    );
    expect(test.execCalls).toHaveLength(2);
  });
});

describe('profiles', () => {
  it('keeps each profile in its own directories and picks one by flag or variable', async () => {
    const server = await board();
    const other = await board();
    const test = runtime({ overrideDirs: false });
    const first = secrets(test, server);
    expect(await runCli(['--profile', 'a', ...initArgs(server.url, first)], test.rt)).toBe(0);
    const second = secrets(test, other);
    const withEnv = { ...test.rt, env: { ...test.rt.env, AGENT_BOARD_PROFILE: 'b' } };
    expect(await runCli(initArgs(other.url, second), withEnv)).toBe(0);

    const a = test.path('xdg-config', 'agent-board', 'profiles', 'a');
    const b = test.path('xdg-config', 'agent-board', 'profiles', 'b');
    expect(readFileSync(path.join(a, 'server.json'), 'utf8')).toContain(server.url);
    expect(readFileSync(path.join(b, 'server.json'), 'utf8')).toContain(other.url);
    expect(existsSync(test.path('xdg-state', 'agent-board', 'profiles', 'a'))).toBe(true);
    expect(existsSync(test.path('xdg-config', 'agent-board', 'profiles', 'default'))).toBe(false);
  });

  it('creates nothing for an invalid profile', async () => {
    const server = await board();
    const test = runtime({ overrideDirs: false });
    const files = secrets(test, server);
    expect(await runCli(['--profile', '-lead', ...initArgs(server.url, files)], test.rt)).toBe(2);
    expect(existsSync(test.path('xdg-config'))).toBe(false);
    expect(existsSync(test.path('xdg-state'))).toBe(false);
  });
});
