import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DOCTOR_CHECK_IDS, doctorReport, type DoctorResult } from '@agent-board/contract';
import { describe, expect, it } from 'vitest';

import { nodeCheck } from '../src/doctor/local.js';
import { parseExecStart } from '../src/doctor/units.js';
import { useRig } from './support/harness.js';
import type { Cli } from './support/profile.js';

const rig = useRig();

async function report(cli: Cli): Promise<DoctorResult[]> {
  cli.reset();
  await cli.run('doctor', '--json');
  return doctorReport.parse(JSON.parse(cli.stdout()));
}

function level(results: readonly DoctorResult[], name: DoctorResult['name']): string | undefined {
  return results.find((entry) => entry.name === name)?.level;
}

describe('board doctor', () => {
  it('[cli-047] reports a healthy profile with the contract check ids and exits 0', async () => {
    const { cli } = await rig();
    expect(await cli.run('doctor', '--json')).toBe(0);
    const results = doctorReport.parse(JSON.parse(cli.stdout()));
    const names = results.map((entry) => entry.name);
    for (const expected of [
      'node',
      'config dir',
      'web.json',
      'env',
      'env mode',
      'token',
      'data key',
      'server',
      'server features',
      'board key',
      'config.json',
      'profile',
      'request-signature',
      'legacy-dirs',
    ] as const) {
      expect(names).toContain(expected);
    }
    for (const name of names) expect(DOCTOR_CHECK_IDS).toContain(name);
    expect(results.filter((entry) => entry.level === 'fail')).toEqual([]);
  });

  it('[cli-047] prints one line per check with its hint and a summary in text mode', async () => {
    const { cli } = await rig({ platform: 'linux' });
    expect(await cli.run('doctor')).toBe(0);
    expect(cli.stdout()).toMatch(/^ok {4}web\.json: server http/m);
    expect(cli.stdout()).toMatch(/^warn {2}dispatch command: .*not installed$/m);
    expect(cli.stdout()).toMatch(/hint: run `board setup`/);
    expect(cli.stdout()).toMatch(/\d+ checks: \d+ ok, \d+ warnings, 0 failures\n$/);
  });

  it('[cli-047] fails on a credentials file with a loose mode and exits 1', async () => {
    const { cli } = await rig();
    chmodSync(cli.test.path('config', 'env'), 0o644);
    expect(await cli.run('doctor', '--json')).toBe(1);
    const results = doctorReport.parse(JSON.parse(cli.stdout()));
    expect(level(results, 'env mode')).toBe('fail');
    expect(level(results, 'token')).toBe('fail');
  });

  it('[cli-047] fails when the data key is not the one of the board', async () => {
    const { cli, stub } = await rig();
    const other = stub.dataKey.slice(0, -1) + (stub.dataKey.endsWith('A') ? 'B' : 'A');
    writeFileSync(
      cli.test.path('config', 'env'),
      `AGENT_BOARD_TOKEN=abm_testtoken\nAGENT_BOARD_DATA_KEY=${other}\n`,
    );
    expect(await cli.run('doctor', '--json')).toBe(1);
    const results = doctorReport.parse(JSON.parse(cli.stdout()));
    expect(level(results, 'board key')).toBe('fail');
    expect(level(results, 'server')).toBe('ok');
  });

  it('[cli-047] fails when the server cannot be reached', async () => {
    const { cli, stub } = await rig();
    await stub.stop();
    expect(await cli.run('doctor', '--json')).toBe(1);
    const results = doctorReport.parse(JSON.parse(cli.stdout()));
    expect(level(results, 'server')).toBe('fail');
    expect(level(results, 'board key')).toBeUndefined();
  });

  it('[cli-047] fails on a profile that was never initialised', async () => {
    const { cli } = await rig();
    const profile = cli.test.rt.env.AGENT_BOARD_CONFIG_DIR ?? '';
    writeFileSync(path.join(profile, 'server.json'), '{');
    expect(await cli.run('doctor', '--json')).toBe(1);
    expect(level(doctorReport.parse(JSON.parse(cli.stdout())), 'web.json')).toBe('fail');
  });

  it('[cli-047] reports an invalid config.yaml under the config.json id', async () => {
    const { cli } = await rig({ config: 'lanes: nope\n' });
    expect(await cli.run('doctor', '--json')).toBe(1);
    expect(level(doctorReport.parse(JSON.parse(cli.stdout())), 'config.json')).toBe('fail');
  });

  it('[cli-047] warns about directories that do not exist and about backups', async () => {
    const { cli } = await rig({
      config:
        'machine: test-machine\ndirs:\n  - id: 11111111-1111-4111-8111-111111111111\n    path: /nonexistent/repository\n',
    });
    writeFileSync(cli.test.path('config', 'env.bak-20260101T000000'), 'old');
    const results = await report(cli);
    expect(level(results, 'dirs')).toBe('warn');
    expect(level(results, 'backups')).toBe('warn');
  });

  it('[cli-047] warns about a board that lacks features and about a legacy document', async () => {
    const { cli, stub } = await rig({ board: { features: ['projects'] } });
    stub.setLegacy('{}', []);
    const results = await report(cli);
    expect(level(results, 'server features')).toBe('warn');
    expect(level(results, 'legacy-dirs')).toBe('warn');
  });

  it('[cli-047] fails when the board requires signed requests and the profile has no key', async () => {
    const { cli } = await rig({ board: { requestSignature: true } });
    expect(await cli.run('doctor', '--json')).toBe(1);
    const results = doctorReport.parse(JSON.parse(cli.stdout()));
    expect(level(results, 'request-signature')).toBe('fail');
  });

  it('[cli-047] fails when an installed unit runs a program that is gone', async () => {
    const { cli } = await rig({ platform: 'linux' });
    const units = path.join(cli.test.rt.homedir, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    writeFileSync(
      path.join(units, 'agent-board-default-listen.service'),
      'ExecStart=/nonexistent/board --profile default internal listen\n',
    );
    const results = await report(cli);
    expect(level(results, 'listen command')).toBe('fail');
  });

  it('[cli-047] reports the state of installed units on Linux', async () => {
    const { cli } = await rig({
      platform: 'linux',
      exec: (file, args) => ({ code: args.includes('is-active') ? 3 : 0, stdout: `${file}` }),
    });
    const units = path.join(cli.test.rt.homedir, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    writeFileSync(
      path.join(units, 'agent-board-default-watch.service'),
      `ExecStart=${process.execPath} --profile default internal watch\n`,
    );
    const results = await report(cli);
    expect(level(results, 'watch command')).toBe('ok');
    expect(level(results, 'watch state')).toBe('warn');
  });

  it('[cli-047] warns about the units of the removed intake', async () => {
    const { cli } = await rig({ platform: 'linux' });
    const units = path.join(cli.test.rt.homedir, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    writeFileSync(path.join(units, 'agent-board-intake.timer'), '[Timer]\n');
    expect(level(await report(cli), 'unit agent-board-intake')).toBe('warn');
  });

  it('[cli-047] reads the credentials command instead of the env file', async () => {
    const { cli } = await rig({ env: { AGENT_BOARD_CREDENTIALS_COMMAND: '/opt/creds' } });
    const results = await report(cli);
    expect(results.find((entry) => entry.name === 'env')?.message).toMatch(
      /AGENT_BOARD_CREDENTIALS_COMMAND/,
    );
    expect(level(results, 'env mode')).toBeUndefined();
  });

  it('[cli-047] checks the Node version', () => {
    expect(nodeCheck('24.1.0').level).toBe('ok');
    expect(nodeCheck('20.9.0').level).toBe('fail');
    expect(nodeCheck(undefined).level).toBe('ok');
  });

  it('[cli-047] parses an ExecStart line the way systemd reads it', () => {
    expect(parseExecStart('[Service]\nExecStart=/a/b "/c d/e" 100%% $$x\n')).toEqual([
      '/a/b',
      '/c d/e',
      '100%',
      '$x',
    ]);
    expect(parseExecStart('[Service]\n')).toBeUndefined();
  });
});
