import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { doctorReport } from '@rumo/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { runAutoUpdate } from '../src/update/auto.js';
import type { UpdateEnv } from '../src/update/apply.js';
import { createBackup, listBackups, pruneBackups } from '../src/update/backups.js';
import { showUpdateHint } from '../src/update/hint.js';
import {
  planMigration,
  readPendingMigration,
  runPendingMigration,
  writePendingMigration,
  type MigrationStep,
} from '../src/update/migrations.js';
import { readUpdateState, writeUpdateState } from '../src/update/state.js';
import { replaceAll } from '../src/update/swap.js';
import { startReleaseServer, type ReleaseServer } from './support/releases.js';
import { useUpdateMachine, type UpdateMachine } from './support/machine.js';

const machine = useUpdateMachine();
const servers: ReleaseServer[] = [];
const clocks: string[] = [];

afterEach(async () => {
  for (const directory of clocks.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const entry of servers.splice(0)) await entry.server.stop();
});

async function withReleases(...versions: string[]): Promise<ReleaseServer> {
  const entry = await startReleaseServer(versions.map((version) => ({ version })));
  servers.push(entry);
  return entry;
}

function dirsOf(m: UpdateMachine) {
  return { profile: 'default', config: m.config, state: m.state, run: m.test.path('run') };
}

function envOf(m: UpdateMachine): UpdateEnv {
  return {
    rt: m.rt,
    dirs: dirsOf(m),
    dryRun: false,
    out: (line) => m.test.rt.io.stdout(`${line}\n`),
  };
}

function step(id: string, since: string, order: string[], fail = false): MigrationStep {
  return {
    id,
    since,
    title: `step ${id}`,
    kind: 'config',
    run: () => {
      if (fail) throw new Error('disk said no');
      order.push(id);
    },
  };
}

describe('local migrations', () => {
  it('[cli-057] plans the steps between two versions in order of version', () => {
    const steps = [
      step('c', '1.2.0', []),
      step('a', '1.1.0', []),
      step('b', '1.1.0', []),
      step('d', '2.0.0', []),
    ];
    expect(planMigration('1.0.0', '1.2.0', steps).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(planMigration('1.1.0', '2.0.0', steps).map((s) => s.id)).toEqual(['c', 'd']);
    expect(planMigration('2.0.0', '2.0.0', steps)).toEqual([]);
  });

  it('[cli-057] runs the pending steps in order and clears the marker', async () => {
    const m = machine();
    const ran: string[] = [];
    const dirs = dirsOf(m);
    writePendingMigration(m.state, { from: '1.0.0', to: '1.2.0', backup: 'b', done: [] });
    const report = await runPendingMigration(dirs, '1.2.0', [
      step('second', '1.2.0', ran),
      step('first', '1.1.0', ran),
    ]);
    expect(ran).toEqual(['first', 'second']);
    expect(report.ran).toEqual(['first', 'second']);
    expect(readPendingMigration(m.state)).toBeNull();
  });

  it('[cli-057] a failing step stops the run, keeps the marker, and a resume skips the done steps', async () => {
    const m = machine();
    const ran: string[] = [];
    const dirs = dirsOf(m);
    writePendingMigration(m.state, { from: '1.0.0', to: '1.2.0', backup: 'b', done: [] });
    await expect(
      runPendingMigration(dirs, '1.2.0', [
        step('one', '1.1.0', ran),
        step('two', '1.1.0', ran, true),
        step('three', '1.2.0', ran),
      ]),
    ).rejects.toThrow(/step two .*stopped: disk said no.*--resume/);
    expect(ran).toEqual(['one']);
    expect(readPendingMigration(m.state)).toMatchObject({
      done: ['one'],
      failed: { id: 'two', message: 'disk said no' },
    });
    const report = await runPendingMigration(dirs, '1.2.0', [
      step('one', '1.1.0', ran),
      step('two', '1.1.0', ran),
      step('three', '1.2.0', ran),
    ]);
    expect(ran).toEqual(['one', 'two', 'three']);
    expect(report.skipped).toEqual(['one']);
    expect(readPendingMigration(m.state)).toBeNull();
  });

  it('[cli-057] self-update --resume ends a pending migration and keeps the newest 3 backups', async () => {
    const m = machine();
    const dirs = dirsOf(m);
    mkdirSync(m.state, { recursive: true });
    for (let at = 0; at < 5; at += 1) {
      createBackup({
        dirs,
        kind: 'update',
        from: '0.0.0',
        to: '0.0.1',
        at: new Date(Date.UTC(2030, 0, 1, 0, 0, at)),
        binary: null,
      });
    }
    writePendingMigration(m.state, { from: '0.0.0', to: '1.0.0', backup: 'x', done: [] });
    expect(await m.run('self-update', '--resume')).toBe(0);
    expect(readPendingMigration(m.state)).toBeNull();
    expect(listBackups(m.state)).toHaveLength(3);
    expect(m.stdout()).toMatch(/needs no local migration/);
    expect(await m.run('self-update', '--resume')).toBe(0);
    expect(m.stdout()).toMatch(/no migration is pending/);
  });

  it('[cli-057] pruneBackups keeps the newest', () => {
    const m = machine();
    const dirs = dirsOf(m);
    mkdirSync(m.state, { recursive: true });
    for (let at = 0; at < 4; at += 1) {
      createBackup({
        dirs,
        kind: 'server',
        from: '1.0.0',
        to: '1.0.0',
        at: new Date(Date.UTC(2030, 0, 1, 0, 0, at)),
        binary: null,
      });
    }
    expect(pruneBackups(m.state, 2)).toHaveLength(2);
    expect(listBackups(m.state).map((backup) => backup.name)).toEqual([
      '20300101T000003-server',
      '20300101T000002-server',
    ]);
  });

  it('[cli-057] internal migration-plan prints the plan as JSON', async () => {
    const m = machine();
    expect(await m.run('internal', 'migration-plan')).toBe(0);
    expect(JSON.parse(m.stdout())).toEqual({ from: '0.0.0', to: '0.0.0', steps: [] });
  });

  it('[cli-057] doctor reports a pending migration as a failure with the way out', async () => {
    const m = machine();
    mkdirSync(m.state, { recursive: true });
    writePendingMigration(m.state, {
      from: '1.0.0',
      to: '1.1.0',
      backup: 'x',
      done: [],
      failed: { id: 'one', message: 'disk said no' },
    });
    await m.run('doctor', '--json');
    const check = doctorReport.parse(JSON.parse(m.stdout())).find((r) => r.name === 'migration');
    expect(check?.level).toBe('fail');
    expect(check?.message).toMatch(/step one stopped: disk said no/);
    expect(check?.hint).toMatch(/--resume/);
  });
});

describe('rollback', () => {
  async function updated(): Promise<UpdateMachine> {
    const entry = await withReleases('1.0.0');
    const m = machine({ releasesUrl: entry.listUrl });
    writeFileSync(path.join(m.config, 'server.json'), '{"url":"http://a.test"}');
    writeFileSync(path.join(m.config, 'keep.txt'), 'before');
    expect(await m.run('self-update')).toBe(0);
    return m;
  }

  it('[cli-058] restores the binary and the files all together and holds auto-update', async () => {
    const m = await updated();
    expect(m.binaryText()).toBe('binary of 1.0.0');
    writeFileSync(path.join(m.config, 'server.json'), '{"url":"http://b.test"}');
    writeFileSync(path.join(m.config, 'added.txt'), 'added by a migration');
    rmSync(path.join(m.config, 'keep.txt'));
    m.test.captured.stdout = '';

    expect(await m.run('self-update', '--rollback')).toBe(0);
    expect(m.binaryText()).toBe('the old binary');
    expect(readFileSync(path.join(m.config, 'server.json'), 'utf8')).toBe(
      '{"url":"http://a.test"}',
    );
    expect(readFileSync(path.join(m.config, 'keep.txt'), 'utf8')).toBe('before');
    expect(existsSync(path.join(m.config, 'added.txt'))).toBe(false);
    expect(readPendingMigration(m.state)).toBeNull();
    expect(listBackups(m.state)).toEqual([]);
    expect(readUpdateState(m.state).held?.version).toBe('1.0.0');
    expect(readdirSync(m.config).filter((name) => /restore-|undo-/.test(name))).toEqual([]);
    expect(m.stdout()).toMatch(/auto-update is held/);

    expect(await m.run('self-update', '--rollback')).toBe(1);
    expect(m.stderr()).toMatch(/no backup/);
  });

  it('[cli-058] a restore that cannot start changes nothing', async () => {
    const m = await updated();
    writeFileSync(path.join(m.config, 'server.json'), '{"url":"http://b.test"}');
    const [backup] = listBackups(m.state);
    expect(backup).toBeDefined();
    rmSync(path.join(backup?.dir ?? '', 'binary'));

    expect(await m.run('self-update', '--rollback')).toBe(1);
    expect(m.stderr()).toMatch(/could not restore .*nothing was changed/);
    expect(m.binaryText()).toBe('binary of 1.0.0');
    expect(readFileSync(path.join(m.config, 'server.json'), 'utf8')).toBe(
      '{"url":"http://b.test"}',
    );
    expect(readUpdateState(m.state).held).toBeUndefined();
  });

  it('[cli-058] replaceAll puts every file back when a later replacement fails', () => {
    const m = machine();
    const root = m.test.path('swap');
    mkdirSync(path.join(root, 'd'), { recursive: true });
    writeFileSync(path.join(root, 'd', 'x'), 'x before');
    writeFileSync(path.join(root, 'source-d'), 'replacement of d');
    writeFileSync(path.join(root, 'source-x'), 'replacement of x');
    expect(() =>
      replaceAll([
        { target: path.join(root, 'd'), source: path.join(root, 'source-d') },
        { target: path.join(root, 'd', 'x'), source: path.join(root, 'source-x') },
      ]),
    ).toThrow();
    expect(readFileSync(path.join(root, 'd', 'x'), 'utf8')).toBe('x before');
    expect(readdirSync(root).sort()).toEqual(['d', 'source-d', 'source-x']);
  });

  it('[cli-058] auto-update stays off while held and a manual update lifts the hold', async () => {
    const m = await updated();
    expect(await m.run('self-update', '--rollback')).toBe(0);
    const entry = await withReleases('2.0.0');
    const held = machine({ releasesUrl: entry.listUrl });
    mkdirSync(held.state, { recursive: true });
    writeUpdateState(held.state, { held: { version: '1.0.0', at: 1 } });
    expect(await runAutoUpdate(envOf(held), 'always', 'client-too-old')).toBe('held');
    expect(entry.server.seen).toHaveLength(0);
    expect(await held.run('self-update')).toBe(0);
    expect(readUpdateState(held.state).held).toBeUndefined();
  });

  it('[cli-058] doctor warns about the hold', async () => {
    const m = machine();
    mkdirSync(m.state, { recursive: true });
    writeUpdateState(m.state, { held: { version: '1.0.0', at: 1 } });
    await m.run('doctor', '--json');
    const check = doctorReport.parse(JSON.parse(m.stdout())).find((r) => r.name === 'auto-update');
    expect(check?.level).toBe('warn');
    expect(check?.message).toMatch(/held since a rollback from 1\.0\.0/);
  });
});

describe('auto-update and the update hint', () => {
  function withClock(releasesUrl: string): { m: UpdateMachine; shift: (seconds: number) => void } {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'rumo-cli-clock-'));
    clocks.push(directory);
    const file = path.join(directory, 'offset');
    writeFileSync(file, '0');
    const m = machine({
      releasesUrl,
      env: { RUMO_E2E: '1', RUMO_CLOCK_OFFSET_FILE: file },
    });
    return {
      m,
      shift: (seconds) => {
        writeFileSync(file, String(seconds));
      },
    };
  }

  it('[cli-060] retries one hour after a failure and not before', async () => {
    const entry = await startReleaseServer([{ version: '1.0.0', checksum: 'b'.repeat(64) }]);
    servers.push(entry);
    const { m, shift } = withClock(entry.listUrl);
    const env = envOf(m);
    expect(await runAutoUpdate(env, 'always', null)).toBe('failed');
    const hits = (): number => entry.server.seen.length;
    const first = hits();
    expect(readUpdateState(m.state).failedAt).toBeDefined();

    expect(await runAutoUpdate(env, 'always', null)).toBe('retry-later');
    expect(hits()).toBe(first);

    shift(59 * 60);
    expect(await runAutoUpdate(env, 'always', null)).toBe('retry-later');
    expect(hits()).toBe(first);

    shift(61 * 60);
    expect(await runAutoUpdate(env, 'always', null)).toBe('failed');
    expect(hits()).toBeGreaterThan(first);
  });

  it('[cli-060] follows the configured mode', async () => {
    const entry = await withReleases('1.0.0');
    const m = machine({ releasesUrl: entry.listUrl });
    const env = envOf(m);
    expect(await runAutoUpdate(env, 'never', 'client-too-old')).toBe('off');
    expect(await runAutoUpdate(env, 'incompatible', 'compatible')).toBe('not-needed');
    expect(entry.server.seen).toHaveLength(0);
    expect(await runAutoUpdate(env, 'incompatible', 'client-too-old')).toBe('updated');
    expect(m.binaryText()).toBe('binary of 1.0.0');
    expect(readUpdateState(m.state).failedAt).toBeUndefined();
  });

  it('[cli-060] does nothing while a migration is pending or when the board is a script', async () => {
    const entry = await withReleases('1.0.0');
    const pending = machine({ releasesUrl: entry.listUrl });
    mkdirSync(pending.state, { recursive: true });
    writePendingMigration(pending.state, { from: '0.0.0', to: '1.0.0', backup: 'x', done: [] });
    expect(await runAutoUpdate(envOf(pending), 'always', null)).toBe('pending-migration');
    const script = machine({ releasesUrl: entry.listUrl, script: true });
    expect(await runAutoUpdate(envOf(script), 'always', null)).toBe('not-installable');
    expect(entry.server.seen).toHaveLength(0);
  });

  it('[cli-060] the update hint shows at most daily and only on a terminal', () => {
    const m = machine();
    mkdirSync(m.state, { recursive: true });
    writeUpdateState(m.state, { latest: '1.0.0' });
    const env = envOf(m);
    showUpdateHint(env, false, false);
    showUpdateHint(env, true, true);
    expect(m.stderr()).toBe('');

    showUpdateHint(env, true, false);
    expect(m.stderr()).toMatch(/rumo 1\.0\.0 is available .*rumo self-update/);
    m.test.captured.stderr = '';
    showUpdateHint(env, true, false);
    expect(m.stderr()).toBe('');

    writeUpdateState(m.state, { latest: '1.0.0', hintShownAt: Date.now() - 25 * 60 * 60_000 });
    showUpdateHint(env, true, false);
    expect(m.stderr()).toMatch(/is available/);
  });

  it('[cli-060] no hint when the recorded release is not newer', () => {
    const m = machine();
    mkdirSync(m.state, { recursive: true });
    writeUpdateState(m.state, { latest: '0.0.0' });
    showUpdateHint(envOf(m), true, false);
    expect(m.stderr()).toBe('');
  });

  it('[cli-060] a command prints the hint after it runs on a terminal, an internal one does not', async () => {
    const m = machine({ tty: true });
    mkdirSync(m.state, { recursive: true });
    writeUpdateState(m.state, { latest: '1.0.0' });
    const rt = { ...m.rt, io: { ...m.rt.io, stderrIsTty: true } };
    const { runCli } = await import('../src/commands/program.js');
    expect(await runCli(['internal', 'migration-plan'], rt)).toBe(0);
    expect(m.stderr()).toBe('');
    expect(await runCli(['version'], rt)).toBe(0);
    expect(m.stderr()).toMatch(/rumo 1\.0\.0 is available/);
  });
});
