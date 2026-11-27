import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { expandVersionServer, runCli } from '../src/commands/program.js';
import { startBoard, TEST_TOKEN, type FakeBoard } from './support/board.js';
import { testRuntime, type TestRuntime, type TestRuntimeOptions } from './support/runtime.js';

const stoppers: (() => Promise<void>)[] = [];
const runtimes: TestRuntime[] = [];

afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function board(): Promise<FakeBoard> {
  const started = await startBoard();
  stoppers.push(() => started.stop());
  return started;
}

function runtime(options: TestRuntimeOptions = {}): TestRuntime {
  const created = testRuntime(options);
  runtimes.push(created);
  return created;
}

describe('rumo init prompts', () => {
  it('[cli-046] asks for the url, the token and the data key when they are missing', async () => {
    const server = await board();
    const test = runtime({
      prompts: { text: [server.url], secret: [TEST_TOKEN, server.dataKey] },
    });
    expect(await runCli(['init'], test.rt)).toBe(0);
    expect(test.asked).toEqual([
      'Board URL',
      'Machine token (starts with abm_)',
      'Data key (starts with abk1_)',
    ]);
    expect(readFileSync(test.path('config', 'env'), 'utf8')).toContain(TEST_TOKEN);
    expect(readFileSync(test.path('config', 'server.json'), 'utf8')).toContain(server.url);
  });

  it('[cli-046] asks only for what the options leave out', async () => {
    const server = await board();
    const test = runtime({ prompts: { secret: [server.dataKey] } });
    writeFileSync(test.path('token'), `${TEST_TOKEN}\n`, { mode: 0o600 });
    expect(
      await runCli(['init', '--url', server.url, '--token-file', test.path('token')], test.rt),
    ).toBe(0);
    expect(test.asked).toEqual(['Data key (starts with abk1_)']);
  });

  it('[cli-046] fails with a usage error when an option is missing and there is no terminal', async () => {
    const test = runtime();
    expect(await runCli(['init'], test.rt)).toBe(2);
    expect(test.captured.stderr).toMatch(/--url is required/);
  });

  it('[cli-046] stops without writing when a prompt is cancelled', async () => {
    const server = await board();
    const test = runtime({ prompts: { text: [server.url], secret: [null] } });
    expect(await runCli(['init'], test.rt)).toBe(1);
    expect(test.captured.stderr).toMatch(/cancelled/);
    expect(existsSync(test.path('config'))).toBe(false);
  });
});

describe('rumo init with a credentials command', () => {
  const COMMAND = '/opt/board/credentials';

  function commandRuntime(server: FakeBoard, extra: TestRuntimeOptions = {}): TestRuntime {
    return runtime({
      env: { RUMO_CREDENTIALS_COMMAND: COMMAND },
      exec: () => ({
        code: 0,
        stdout: `RUMO_TOKEN=${TEST_TOKEN}\nRUMO_DATA_KEY=${server.dataKey}\n`,
      }),
      ...extra,
    });
  }

  it('[cli-046] refuses --token-file and --data-key-file and writes nothing', async () => {
    const server = await board();
    const test = commandRuntime(server);
    writeFileSync(test.path('token'), TEST_TOKEN, { mode: 0o600 });
    expect(
      await runCli(['init', '--url', server.url, '--token-file', test.path('token')], test.rt),
    ).toBe(2);
    expect(test.captured.stderr).toMatch(
      /--token-file cannot be used while RUMO_CREDENTIALS_COMMAND/,
    );
    expect(
      await runCli(['init', '--url', server.url, '--data-key-file', test.path('token')], test.rt),
    ).toBe(2);
    expect(existsSync(test.path('config'))).toBe(false);
  });

  it('[cli-046] refuses --keychain', async () => {
    const server = await board();
    const test = commandRuntime(server, { platform: 'darwin' });
    expect(await runCli(['init', '--url', server.url, '--keychain'], test.rt)).toBe(2);
  });

  it('[cli-046] takes the credentials from the command and stores no secret', async () => {
    const server = await board();
    const test = commandRuntime(server);
    expect(await runCli(['init', '--url', server.url], test.rt)).toBe(0);
    expect(existsSync(test.path('config', 'env'))).toBe(false);
    expect(existsSync(test.path('config', 'server.json'))).toBe(true);
    expect(test.captured.stdout).toMatch(
      /ok {4}env: credentials come from RUMO_CREDENTIALS_COMMAND/,
    );
  });
});

describe('rumo init runs the doctor checks', () => {
  it('[cli-046] prints the checks after writing and exits 0 when none fails', async () => {
    const server = await board();
    const test = runtime();
    writeFileSync(test.path('token'), TEST_TOKEN, { mode: 0o600 });
    writeFileSync(test.path('key'), server.dataKey, { mode: 0o600 });
    const args = [
      'init',
      '--url',
      server.url,
      '--token-file',
      test.path('token'),
      '--data-key-file',
      test.path('key'),
    ];
    expect(await runCli(args, test.rt)).toBe(0);
    expect(test.captured.stdout).toMatch(/ok {4}board key: the board accepts this machine/);
    expect(test.captured.stdout).toMatch(/\d+ checks: \d+ ok, \d+ warnings, 0 failures/);
  });

  it('[cli-046] exits 1 after writing when a check fails', async () => {
    const server = await board();
    const test = runtime();
    writeFileSync(test.path('token'), TEST_TOKEN, { mode: 0o600 });
    writeFileSync(test.path('key'), server.dataKey, { mode: 0o600 });
    const args = [
      'init',
      '--url',
      server.url,
      '--token-file',
      test.path('token'),
      '--data-key-file',
      test.path('key'),
    ];
    expect(await runCli(args, test.rt)).toBe(0);
    writeFileSync(test.path('config', 'config.yaml'), 'lanes: nope\n');
    expect(await runCli([...args, '--force'], test.rt)).toBe(1);
    expect(test.captured.stdout).toMatch(/FAIL {2}config\.json:/);
    expect(existsSync(test.path('config', 'server.json'))).toBe(true);
  });

  it('[cli-046] a dry run prints no checks', async () => {
    const server = await board();
    const test = runtime();
    writeFileSync(test.path('token'), TEST_TOKEN, { mode: 0o600 });
    writeFileSync(test.path('key'), server.dataKey, { mode: 0o600 });
    const args = [
      'init',
      '--dry-run',
      '--url',
      server.url,
      '--token-file',
      test.path('token'),
      '--data-key-file',
      test.path('key'),
    ];
    expect(await runCli(args, test.rt)).toBe(0);
    expect(test.captured.stdout).toBe('DRY init\n');
  });
});

describe('rumo --version --server', () => {
  it('[cli-011] prints the version report of the profile like board version', async () => {
    const server = await board();
    const test = runtime();
    writeFileSync(test.path('token'), TEST_TOKEN, { mode: 0o600 });
    writeFileSync(test.path('key'), server.dataKey, { mode: 0o600 });
    await runCli(
      [
        'init',
        '--url',
        server.url,
        '--token-file',
        test.path('token'),
        '--data-key-file',
        test.path('key'),
      ],
      test.rt,
    );
    test.captured.stdout = '';
    expect(await runCli(['--version', '--server'], test.rt)).toBe(0);
    expect(test.captured.stdout).toContain('contract:');
    expect(test.captured.stdout).toContain(`server: ${server.url}`);
  });

  it('[cli-011] leaves any other use of --version and --server alone', () => {
    expect(expandVersionServer(['--version'])).toEqual(['--version']);
    expect(expandVersionServer(['self-update', '--server', 'https://x', '--version'])).toEqual([
      'self-update',
      '--server',
      'https://x',
      '--version',
    ]);
    expect(expandVersionServer(['--profile', 'work', '-V', '--server'])).toEqual([
      '--profile',
      'work',
      'version',
    ]);
  });
});
