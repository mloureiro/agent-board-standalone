import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listBackups } from '../src/update/backups.js';
import { startBoard, type FakeBoard, type FakeBoardOptions } from './support/board.js';
import { startServer, type FakeServer } from './support/server.js';
import { useRig, type Rig } from './support/harness.js';

const rig = useRig();
const targets: FakeServer[] = [];

afterEach(async () => {
  for (const target of targets.splice(0)) await target.stop();
});

async function target(options: FakeBoardOptions): Promise<FakeBoard> {
  const stub = await startBoard(options);
  targets.push(stub);
  return stub;
}

const serverUrl = (source: Rig): string =>
  (
    JSON.parse(readFileSync(path.join(source.cli.test.path('config'), 'server.json'), 'utf8')) as {
      url: string;
    }
  ).url;

describe('rumo self-update --server', () => {
  it('[cli-059] moves the machine after the target accepts the token, the owner and the key id', async () => {
    const source = await rig();
    const board = await target({ keyId: source.stub.keys.keyId });
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(0);
    expect(serverUrl(source)).toBe(board.url);
    expect(source.cli.stdout()).toMatch(/checked .*accepts this machine's token/);
    expect(listBackups(source.cli.test.path('state'))[0]?.manifest.kind).toBe('server');
    expect(board.seen.some((request) => request.path === '/api/machine/version')).toBe(true);
  });

  it('[cli-059] --rollback puts the old server back without holding auto-update', async () => {
    const source = await rig();
    const before = serverUrl(source);
    const board = await target({ keyId: source.stub.keys.keyId });
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(0);
    expect(await source.cli.run('self-update', '--rollback')).toBe(0);
    expect(serverUrl(source)).toBe(before);
    expect(source.cli.stdout()).not.toMatch(/held/);
  });

  it('[cli-059] refuses a server whose owner differs and changes nothing', async () => {
    const source = await rig();
    const before = serverUrl(source);
    const board = await target({
      keyId: source.stub.keys.keyId,
      machineVersion: () => ({ owner: 'another-owner' }),
    });
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(1);
    expect(source.cli.stderr()).toMatch(/owner another-owner/);
    expect(serverUrl(source)).toBe(before);
    expect(listBackups(source.cli.test.path('state'))).toEqual([]);
  });

  it('[cli-059] refuses a server holding another key id and changes nothing', async () => {
    const source = await rig();
    const before = serverUrl(source);
    const board = await target({});
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(1);
    expect(source.cli.stderr()).toMatch(/key id/);
    expect(serverUrl(source)).toBe(before);
  });

  it('[cli-059] refuses a server that does not know the token and says what it must hold', async () => {
    const source = await rig();
    const before = serverUrl(source);
    const board = await startServer(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'a valid machine token is required' } },
    }));
    targets.push(board);
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(1);
    expect(source.cli.stderr()).toMatch(/does not accept this machine's token.*owner and key id/);
    expect(source.cli.stderr()).toContain('test-owner');
    expect(serverUrl(source)).toBe(before);
  });

  it('[cli-059] warns about the other machines the old server saw in the last 15 minutes', async () => {
    const source = await rig();
    const board = await target({ keyId: source.stub.keys.keyId });
    source.stub.setMachines([
      { name: 'peer-a', lastSeenAt: new Date(Date.now() - 60_000).toISOString() },
      { name: 'peer-old', lastSeenAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
      { name: 'peer-never', lastSeenAt: null },
    ]);
    expect(await source.cli.run('self-update', '--server', board.url)).toBe(0);
    expect(source.cli.stdout()).toMatch(/1 other machine\(s\).*peer-a/);
    expect(source.cli.stdout()).not.toContain('peer-old');
    expect(source.cli.stdout()).not.toContain('peer-never');
  });

  it('[cli-059] says so when the machine already uses that server', async () => {
    const source = await rig();
    expect(await source.cli.run('self-update', '--server', source.stub.url)).toBe(0);
    expect(source.cli.stdout()).toMatch(/already uses/);
    expect(listBackups(source.cli.test.path('state'))).toEqual([]);
  });

  it('[cli-059] --dry-run checks the target and writes nothing', async () => {
    const source = await rig();
    const before = serverUrl(source);
    const board = await target({ keyId: source.stub.keys.keyId });
    expect(await source.cli.run('--dry-run', 'self-update', '--server', board.url)).toBe(0);
    expect(source.cli.stdout()).toMatch(/DRY write server\.json/);
    expect(serverUrl(source)).toBe(before);
  });

  it('[cli-059] refuses a URL that is not a board URL and a target that cannot be reached', async () => {
    const source = await rig();
    expect(await source.cli.run('self-update', '--server', 'ftp://example.test')).toBe(2);
    expect(source.cli.stderr()).toMatch(/--server must be https/);
    source.cli.reset();
    expect(await source.cli.run('self-update', '--server', 'http://127.0.0.1:1')).toBe(1);
    expect(source.cli.stderr()).toMatch(/cannot be used/);
  });
});
