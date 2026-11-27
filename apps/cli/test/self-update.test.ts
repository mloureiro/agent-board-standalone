import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listBackups } from '../src/update/backups.js';
import { readPendingMigration } from '../src/update/migrations.js';
import { readUpdateState } from '../src/update/state.js';
import { startReleaseServer, type FakeRelease, type ReleaseServer } from './support/releases.js';
import { useUpdateMachine } from './support/machine.js';

const machine = useUpdateMachine();
const servers: ReleaseServer[] = [];

afterEach(async () => {
  for (const entry of servers.splice(0)) await entry.server.stop();
});

async function releases(list: readonly FakeRelease[]): Promise<ReleaseServer> {
  const entry = await startReleaseServer(list);
  servers.push(entry);
  return entry;
}

const assetRequests = (entry: ReleaseServer): number =>
  entry.server.seen.filter((request) => request.path.startsWith('/assets')).length;

describe('rumo self-update', () => {
  it('[cli-056] downloads the newest cli-v release, verifies its checksum and swaps the binary', async () => {
    const entry = await releases([
      { version: '0.5.0' },
      { version: '1.0.0' },
      { version: '2.0.0', prerelease: true },
      { version: '3.0.0', draft: true },
      { version: '9.0.0', tagPrefix: 'api-v' },
    ]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('self-update')).toBe(0);
    expect(m.binaryText()).toBe('binary of 1.0.0');
    expect(m.stdout().match(/checksums only, no signature key built in/g)).toHaveLength(1);
    expect(m.test.spawnCalls.map((call) => [call.file, ...call.args])).toEqual([
      [realpathSync(m.binary), '--profile', 'default', 'self-update', '--resume'],
    ]);
    const [backup] = listBackups(m.state);
    expect(backup?.manifest).toMatchObject({ kind: 'update', from: '0.0.0', to: '1.0.0' });
    expect(readFileSync(path.join(backup?.dir ?? '', 'binary'), 'utf8')).toBe('the old binary');
    expect(existsSync(path.join(m.state, 'update-staging'))).toBe(false);
    expect(readdirSync(path.dirname(m.binary))).toEqual(['rumo']);
    expect(readPendingMigration(m.state)).toMatchObject({ from: '0.0.0', to: '1.0.0' });
  });

  it('[cli-056] a checksum that does not match leaves the binary and the state untouched', async () => {
    const entry = await releases([{ version: '1.0.0', checksum: 'a'.repeat(64) }]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/checksum/);
    expect(m.binaryText()).toBe('the old binary');
    expect(listBackups(m.state)).toEqual([]);
    expect(readPendingMigration(m.state)).toBeNull();
    expect(existsSync(path.join(m.state, 'update-staging'))).toBe(false);
  });

  it('[cli-056] a release without a checksum list is refused', async () => {
    const entry = await releases([{ version: '1.0.0', noChecksums: true }]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/SHA256SUMS/);
    expect(m.binaryText()).toBe('the old binary');
  });

  it('[cli-056] a download that does not run as the release version is refused', async () => {
    const entry = await releases([{ version: '1.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl, reportedVersion: '7.7.7' });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/does not report version 1\.0\.0/);
    expect(m.binaryText()).toBe('the old binary');
  });

  it('[cli-056] says so when the newest release is not newer', async () => {
    const entry = await releases([{ version: '0.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('self-update')).toBe(0);
    expect(m.stdout()).toMatch(/newest release/);
    expect(assetRequests(entry)).toBe(0);
  });

  it('[cli-056] --check reports and records the newest version without downloading', async () => {
    const entry = await releases([{ version: '1.2.0' }]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('self-update', '--check')).toBe(0);
    expect(m.stdout()).toMatch(/rumo 1\.2\.0 is available/);
    expect(readUpdateState(m.state).latest).toBe('1.2.0');
    expect(assetRequests(entry)).toBe(0);
    expect(m.binaryText()).toBe('the old binary');
  });

  it('[cli-056] --dry-run downloads and changes nothing', async () => {
    const entry = await releases([{ version: '1.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl });
    expect(await m.run('--dry-run', 'self-update')).toBe(0);
    expect(m.stdout()).toMatch(/DRY download cli-v1\.0\.0 for linux-x64/);
    expect(assetRequests(entry)).toBe(0);
    expect(m.binaryText()).toBe('the old binary');
  });

  it('[cli-056] a script run cannot be replaced and says why', async () => {
    const entry = await releases([{ version: '1.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl, script: true });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/compiled binary/);
  });

  it('[cli-056] a platform without a release build is refused', async () => {
    const entry = await releases([{ version: '1.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl, arch: 'arm' });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/no release build for linux-arm/);
  });

  it('[cli-056] an unreachable release list is reported', async () => {
    const m = machine({ releasesUrl: 'http://127.0.0.1:1/releases' });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/could not reach the release list/);
  });

  it('[cli-056] a release list over plain http to a remote host is refused', async () => {
    const m = machine({ releasesUrl: 'http://example.test/releases' });
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/https/);
  });

  it('[cli-056] refuses to run inside a board run and with clashing options', async () => {
    const m = machine({ env: { RUMO_TASK: 'abc12345' } });
    expect(await m.run('self-update')).toBe(1);
    const other = machine();
    expect(await other.run('self-update', '--server', 'http://127.0.0.1:1', '--check')).toBe(2);
    expect(await other.run('self-update', '--rollback', '--check')).toBe(2);
    expect(other.stderr()).toMatch(/cannot be combined/);
  });

  it('[cli-056] refuses while a migration is pending', async () => {
    const entry = await releases([{ version: '1.0.0' }]);
    const m = machine({ releasesUrl: entry.listUrl });
    mkdirSync(m.state, { recursive: true });
    writeFileSync(
      path.join(m.state, 'migration.json'),
      JSON.stringify({ from: '0.0.0', to: '0.1.0', backup: 'x', done: [] }),
    );
    expect(await m.run('self-update')).toBe(1);
    expect(m.stderr()).toMatch(/migration is pending/);
    expect(m.binaryText()).toBe('the old binary');
  });
});
