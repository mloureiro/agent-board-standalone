import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  previousMigration,
  previousSchemaMissing,
  writePreviousSchemaFolder,
} from './previous-schema.js';
import {
  agentsOf,
  bundledApp,
  keySetup,
  MACHINE,
  mentioning,
  missing,
  startApp,
  treeOf,
  type RealApp,
} from './real.js';
import { RESOURCES_DIR } from '../scripts/layout.ts';
import { isAlive, until } from './support.js';

const SLEEPING_CARD = '#stub: sleep 300';

describe('the real API, CLI and web build run by the app', { timeout: 120_000 }, () => {
  const apps: RealApp[] = [];

  beforeEach((context) => {
    if (missing !== undefined) context.skip(missing);
  });

  afterEach(() => {
    for (const app of apps.splice(0).reverse()) app.dispose();
  });

  async function started(options: Parameters<typeof startApp>[0] = {}): Promise<RealApp> {
    const app = await startApp(options);
    apps.push(app);
    return app;
  }

  async function runningCard(app: RealApp): Promise<string> {
    await app.enrol();
    const directory = join(app.scratch, 'work');
    mkdirSync(directory, { recursive: true });
    expect(app.board(['dirs', 'add', directory]).code).toBe(0);
    const made = app.board(
      ['schedule', '--json', '--title', 'long card', '--auto-done', SLEEPING_CARD],
      { cwd: directory },
    );
    expect(made.code, made.stderr).toBe(0);
    const id = (JSON.parse(made.stdout) as { id: string }).id;
    await until(() => taskOf(app, id)?.['status'] === 'running', 'the card running', 90);
    await until(() => agentsOf(app.scratch).length > 0, 'the stub claude process', 60);
    return id;
  }

  function taskOf(app: RealApp, id: string): Record<string, unknown> | undefined {
    const listed = app.board(['tasks', '--json']);
    if (listed.code !== 0) return undefined;
    return (JSON.parse(listed.stdout) as Record<string, unknown>[]).find(
      (task) => task['id'] === id,
    );
  }

  it('[server-app-010] a local browser at http://localhost:<port>/ gets the browser client', async () => {
    const app = await started({ bundle: bundledApp !== undefined });

    const response = await fetch(`http://localhost:${app.port}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toBe(readFileSync(join(RESOURCES_DIR, 'web/index.html'), 'utf8'));
    const version = await fetch(`http://localhost:${app.port}/version.json`);
    expect(await version.text()).toBe(
      readFileSync(join(RESOURCES_DIR, 'web/version.json'), 'utf8'),
    );
  });

  it('[server-app-003] nothing in the whole process tree listens beyond 127.0.0.1 or [::1]', async () => {
    const app = await started();
    await runningCard(app);
    const pids = [
      app.session.child.pid as number,
      ...treeOf(app.session.child.pid as number).map((entry) => entry.pid),
      ...agentsOf(app.scratch).map((entry) => entry.pid),
    ];
    expect(pids.length).toBeGreaterThan(4);

    const listing = spawnSync(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')],
      {
        encoding: 'utf8',
      },
    ).stdout;
    const addresses = listing
      .split('\n')
      .slice(1)
      .filter((line) => line.includes('(LISTEN)'))
      .map((line) => line.split(/\s+/).at(-2) as string);
    const udp = spawnSync('lsof', ['-nP', '-iUDP', '-a', '-p', pids.join(',')], {
      encoding: 'utf8',
    }).stdout;

    expect(addresses).toContain(`127.0.0.1:${app.port}`);
    for (const address of addresses) expect(address).toMatch(/^(127\.0\.0\.1|\[::1\]):\d+$/);
    expect(udp.trim()).toBe('');
  });

  describe.each([
    ['Quit', async (app: RealApp) => app.quit()],
    [
      'SIGTERM',
      async (app: RealApp) => {
        app.session.child.kill('SIGTERM');
        return app.session.closed;
      },
    ],
  ])('[server-app-005] after %s', (_, stop) => {
    it('no API, worker or run process remains and the running card is paused and resumable', async () => {
      const first = await started();
      const id = await runningCard(first);
      const before = [
        first.session.child.pid as number,
        ...treeOf(first.session.child.pid as number).map((entry) => entry.pid),
        ...agentsOf(first.scratch).map((entry) => entry.pid),
      ];
      expect(agentsOf(first.scratch).length).toBeGreaterThan(0);

      expect(await stop(first)).toBe(0);

      for (const pid of before) expect(isAlive(pid), `process ${pid}`).toBe(false);
      expect(mentioning(first.scratch).map((entry) => entry.command)).toEqual([]);
      expect(agentsOf(first.scratch)).toEqual([]);

      const second = await started({ reuse: first });
      await until(
        () => {
          const task = taskOf(second, id);
          return task !== undefined && task['status'] !== 'running';
        },
        'the card to leave running',
        60,
      );
      const task = taskOf(second, id) as Record<string, unknown>;
      expect(task['paused']).toBe(true);
      expect(task['next']).toBe('resume');
    });
  });

  it('[server-app-007] the worker keeps its config, state and run folders under the app root and writes nothing under HOME', async () => {
    const home = join(process.env['TMPDIR'] ?? '/tmp', `sa-home-${process.pid}`);
    mkdirSync(home, { recursive: true });
    const app = await started({ env: { HOME: home } });
    await app.enrol();

    for (const folder of ['config', 'state', 'run']) {
      expect(existsSync(join(app.root, 'worker', folder)), folder).toBe(true);
    }
    expect(readdirSync(join(app.root, 'worker/config')).length).toBeGreaterThan(0);
    const listed = spawnSync('find', [home], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(
      listed.filter((entry) => /rumo|\.config|launchd|Library/i.test(entry.slice(home.length))),
    ).toEqual([]);
    spawnSync('rm', ['-rf', home]);
  });

  it('[server-app-009] a data folder written by the previous schema opens with its rows after one pre-upgrade backup', async () => {
    if (previousSchemaMissing !== undefined)
      return void expect.soft(previousSchemaMissing).toBeUndefined();
    const first = await started({
      prepare: ({ scratch, dataDir, port }) =>
        writePreviousSchemaFolder(scratch, dataDir, port, keySetup, MACHINE),
    });

    const keys = (await (
      await fetch(`${first.url}/api/client/keys/get`, { headers: { 'x-board-contract': '1' } })
    ).json()) as { setup: { keyId: string } | null };
    const machines = (await (
      await fetch(`${first.url}/api/client/machines/list`, { headers: { 'x-board-contract': '1' } })
    ).json()) as { machines: { name: string }[] };

    expect(keys.setup?.keyId).toBe(keySetup.keyId);
    expect(machines.machines.map((machine) => machine.name)).toContain(MACHINE);
    const backups = readdirSync(join(first.root, 'backups')).filter((name) =>
      name.startsWith('pre-upgrade-'),
    );
    const bundledSchema = readFileSync(join(RESOURCES_DIR, 'api/schema-version'), 'utf8').trim();
    expect(bundledSchema).not.toBe(previousMigration());
    expect(backups).toHaveLength(1);
    expect(backups[0]?.startsWith(`pre-upgrade-${bundledSchema}-`)).toBe(true);
    expect(readdirSync(join(first.root, 'backups', backups[0] as string)).length).toBeGreaterThan(
      0,
    );
    expect(readFileSync(join(first.root, 'data-schema-version'), 'utf8').trim()).toBe(
      bundledSchema,
    );

    await first.quit();
    const second = await started({ reuse: first });
    expect(
      readdirSync(join(second.root, 'backups')).filter((name) => name.startsWith('pre-upgrade-')),
    ).toHaveLength(1);
  });
});
