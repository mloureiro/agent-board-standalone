import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binary,
  FAST_TIMINGS,
  freePort,
  isAlive,
  launch,
  prepareResources,
  type Event,
  type Resources,
  type Session,
  SKIP_REASON,
  stub,
  until,
  writeSettings,
} from './support.js';

const here = dirname(fileURLToPath(import.meta.url));
const STUB_BOARD = join(here, '../src-tauri/core/tests/fixtures/stub-board.sh');
const DROPPED_CHECKS = join(here, '../src-tauri/core/src/dropped_checks.json');
const CONTRACT_DOCTOR = join(here, '../../../packages/contract/src/doctor.ts');
const REAL_CLI = join(here, '../../cli/dist/rumo');
const GOOD = 'abm_good abk1_good';

describe('worker and enrolment through the headless runner', () => {
  let scratch: string;
  let root: string;
  let port: number;
  let resources: Resources;
  let toolDir: string;
  const sessions: Session[] = [];

  beforeEach(async (context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    scratch = mkdtempSync(join(tmpdir(), 'server-app-worker-'));
    root = join(scratch, 'root');
    port = await freePort();
    toolDir = join(scratch, 'tools');
    mkdirSync(toolDir, { recursive: true });
    for (const name of ['claude', 'gh']) {
      writeFileSync(join(toolDir, name), '#!/bin/sh\n');
      chmodSync(join(toolDir, name), 0o755);
    }
    writeSettings(root, { port, workerPath: toolDir });
    resources = prepareResources(scratch);
    installCli(STUB_BOARD, '');
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    for (const pidFile of ['run/api.pid', 'run/worker-listen.pid', 'run/worker-watch.pid']) {
      const file = join(root, pidFile);
      if (existsSync(file)) {
        try {
          process.kill(Number(readFileSync(file, 'utf8').split('\n')[0]), 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  function installCli(source: string, conf: string): void {
    const directory = join(resources.dir, 'cli');
    mkdirSync(directory, { recursive: true });
    copyFileSync(source, join(directory, 'rumo'));
    chmodSync(join(directory, 'rumo'), 0o755);
    writeFileSync(join(directory, 'board.conf'), `${conf}\n`);
  }

  function start(): Session {
    const session = launch(root, {
      RUMO_SERVER_RESOURCES: resources.dir,
      RUMO_SUPERVISION_TIMINGS: FAST_TIMINGS,
    });
    sessions.push(session);
    return session;
  }

  const workerRow = (session: Session): { state: string; text: string } | undefined => {
    const states = session.events.filter((event) => event['type'] === 'state');
    const supervision = states.at(-1)?.['supervision'] as
      { worker: { state: string; text: string } } | undefined;
    return supervision?.worker;
  };

  async function untilRow(session: Session, text: (value: string) => boolean): Promise<void> {
    await until(() => {
      session.send('state');
      const row = workerRow(session);
      return row !== undefined && text(row.text);
    }, 'the worker row');
  }

  async function apiRunning(session: Session): Promise<void> {
    await until(() => {
      session.send('state');
      const states = session.events.filter((event) => event['type'] === 'state');
      const supervision = states.at(-1)?.['supervision'] as { api: { state: string } } | undefined;
      return supervision?.api.state === 'running';
    }, 'the API running');
  }

  async function act(session: Session, line: string, action: string): Promise<Event> {
    const before = session.events.length;
    session.send(line);
    let found: Event | undefined;
    await until(() => {
      found = session.events
        .slice(before)
        .find((event) => event['type'] === 'action' && event['action'] === action);
      return found !== undefined;
    }, `the ${action} answer`);
    return found as Event;
  }

  const stubLog = (): string[] => {
    const file = join(root, 'worker/stub.log');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  };
  const count = (prefix: string): number =>
    stubLog().filter((line) => line.startsWith(prefix)).length;
  const credentials = (): Record<string, Record<string, string>> => {
    const file = join(scratch, 'credentials.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  };
  const stored = (): Record<string, string> => Object.values(credentials())[0] ?? {};

  async function connected(): Promise<Session> {
    const session = start();
    await apiRunning(session);
    const answer = await act(session, `connect-worker ${GOOD}`, 'connect-worker');
    expect(answer['ok']).toBe(true);
    await until(() => count('listen start') >= 1 && count('watch start') >= 1, 'the worker');
    return session;
  }

  function filesUnder(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : entry.isSymbolicLink() ? [] : [path];
    });
  }

  it('[server-app-046] before enrolment the row says "Worker not connected" and nothing runs', async () => {
    const session = start();
    await apiRunning(session);
    await untilRow(session, (text) => text === 'Worker not connected');
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(workerRow(session)).toEqual({ state: 'off', text: 'Worker not connected' });
    expect(count('listen start') + count('watch start') + count('dispatch')).toBe(0);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-050] a refused pair stops, pauses and stores nothing [server-app-048]', async () => {
    const session = start();
    await apiRunning(session);

    for (const line of [
      'connect-worker abm_wrong abk1_good',
      'connect-worker abm_good abk1_wrong',
    ]) {
      const answer = await act(session, line, 'connect-worker');
      expect(answer['ok']).toBe(false);
      expect(String(answer['message'])).toMatch(/401|data key/);
      expect(JSON.stringify(session.events)).not.toContain('abk1_wrong');
    }

    expect(stored()).toEqual({});
    expect(count('shutdown')).toBe(0);
    expect(workerRow(session)).toEqual({ state: 'off', text: 'Worker not connected' });
    session.send('quit');
    await session.closed;
  });

  it('[server-app-050] an accepted pair is promoted and the worker starts [server-app-049] [server-app-053]', async () => {
    installCli(STUB_BOARD, 'MACHINE=the-name-the-server-gave');
    const session = start();
    await apiRunning(session);

    const answer = await act(session, `connect-worker ${GOOD}`, 'connect-worker');

    expect(answer).toMatchObject({
      ok: true,
      machine: 'the-name-the-server-gave',
      message: 'Connected as the-name-the-server-gave',
    });
    expect(Object.keys(stored()).sort()).toEqual(['worker-data-key', 'worker-token']);
    expect(count('shutdown')).toBe(1);
    await until(() => count('listen start') === 1, 'the listener');
    await untilRow(session, (text) => text === 'ok');
    expect(readFileSync(join(root, 'worker/config/config.yaml'), 'utf8')).toContain(
      'machine: the-name-the-server-gave',
    );
    for (const file of filesUnder(root)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain('abm_good');
      expect(text, file).not.toContain('abk1_good');
    }
    expect(JSON.stringify(session.events)).not.toContain('abk1_good');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-055] a pasted prefix is stripped and a malformed line is refused', async () => {
    const session = start();
    await apiRunning(session);

    const refused = await act(session, 'connect-worker abm_good', 'connect-worker');
    expect(refused['ok']).toBe(false);
    expect(refused['message']).toBe('connect-worker needs a token and a data key');

    const accepted = await act(
      session,
      'connect-worker RUMO_TOKEN=abm_good RUMO_DATA_KEY=abk1_good',
      'connect-worker',
    );
    expect(accepted['ok']).toBe(true);
    expect(stored()['worker-token']).toBe('abm_good');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-051] a pending pair left by a crash is discarded at the next start', async () => {
    const session = start();
    await apiRunning(session);
    const service = (session.events.find((event) => event['type'] === 'state') ?? {})[
      'keychainService'
    ] as string;
    session.send('quit');
    await session.closed;
    writeFileSync(
      join(scratch, 'credentials.json'),
      JSON.stringify({
        [service]: { 'worker-token.pending': 'abm_left', 'worker-data-key.pending': 'abk1_left' },
      }),
    );

    const next = start();
    await apiRunning(next);

    await until(() => Object.keys(stored()).length === 0, 'the pending pair to go');
    next.send('quit');
    await next.closed;
  });

  it('[server-app-019] disconnect stops the worker, pauses cards and deletes the pair but keeps the config', async () => {
    const session = await connected();
    const pauses = count('shutdown');
    const listener = Number(
      stubLog()
        .find((line) => line.startsWith('listen start'))
        ?.split(' ')[2],
    );

    const answer = await act(session, 'disconnect-worker', 'disconnect-worker');

    expect(answer).toMatchObject({ ok: true, message: 'Worker not connected' });
    expect(stored()).toEqual({});
    expect(count('shutdown')).toBe(pauses + 1);
    expect(isAlive(listener)).toBe(false);
    await untilRow(session, (text) => text === 'Worker not connected');
    expect(existsSync(join(root, 'worker/config/server.json'))).toBe(true);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-018] restart-worker restarts the processes without pausing cards', async () => {
    const session = await connected();
    const pauses = count('shutdown');

    const answer = await act(session, 'restart-worker', 'restart-worker');

    expect(answer['ok']).toBe(true);
    await until(() => count('listen start') === 2 && count('watch start') === 2, 'the restart');
    expect(count('shutdown')).toBe(pauses);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-018] restart-worker, check-worker and disconnect-worker refuse while not connected', async () => {
    const session = start();
    await apiRunning(session);

    for (const action of ['restart-worker', 'check-worker']) {
      const answer = await act(session, action, action);
      expect(answer).toMatchObject({ ok: false, message: 'Worker not connected' });
    }
    session.send('quit');
    await session.closed;
  });

  it('[server-app-020] check-worker drops the named checks, looks up claude and gh and opens a log', async () => {
    const session = await connected();
    const answer = await act(session, 'check-worker', 'check-worker');

    expect(answer).toMatchObject({ ok: true, message: 'check: 1 problem(s)' });
    const log = readFileSync(join(root, 'logs/check-worker.log'), 'utf8');
    expect(log).toContain('node: node 24');
    expect(log).toContain('git: git did not run');
    expect(log).not.toContain('launchd agents');
    expect(log).toContain(`claude: ${join(toolDir, 'claude')}`);
    expect(log.trim().endsWith('check: 1 problem(s)')).toBe(true);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-020] every dropped check is a typed id of the contract', () => {
    const dropped = JSON.parse(readFileSync(DROPPED_CHECKS, 'utf8')) as string[];
    const contract = readFileSync(CONTRACT_DOCTOR, 'utf8');
    const ids = [...contract.matchAll(/^\s+(['"])(.+)\1,$/gm)].map((match) => match[2]);
    expect(dropped.length).toBeGreaterThan(0);
    expect(ids.length).toBeGreaterThan(30);
    for (const name of dropped) expect(ids).toContain(name);
  });

  it('[server-app-057] a worker configured for another server URL has its init re-run at start', async () => {
    const first = await connected();
    first.send('quit');
    await first.closed;
    writeFileSync(
      join(root, 'worker/config/server.json'),
      JSON.stringify({ url: 'http://127.0.0.1:1' }),
    );
    const inits = count('init ');

    const next = start();
    await apiRunning(next);

    await until(() => count('init ') === inits + 1, 'the init');
    expect(
      stubLog()
        .filter((line) => line.startsWith('init '))
        .at(-1),
    ).toBe(`init http://127.0.0.1:${port}`);
    next.send('quit');
    await next.closed;
  });

  it('[server-app-058] quit terminates the worker, pauses the cards and kills stragglers', async () => {
    installCli(STUB_BOARD, 'IGNORE_TERM_WATCH=1');
    const session = await connected();
    const pauses = count('shutdown');
    const watcher = Number(
      stubLog()
        .find((line) => line.startsWith('watch start'))
        ?.split(' ')[2],
    );

    session.send('quit');
    await session.closed;

    const log = stubLog();
    const quitPause = log.findLastIndex((line) => line.startsWith('shutdown'));
    expect(count('shutdown')).toBe(pauses + 1);
    expect(log.indexOf('listen term')).toBeGreaterThan(-1);
    expect(log.indexOf('listen term')).toBeLessThan(quitPause);
    expect(isAlive(watcher)).toBe(false);
  });

  it('[server-app-059] the wrapper in the worker bin refuses the managed commands', async () => {
    const session = await connected();
    const { spawnSync } = await import('node:child_process');
    const wrapper = join(root, 'worker/bin/rumo');

    for (const command of ['setup', 'self-update', 'restart', 'init']) {
      expect(spawnSync('/bin/sh', [wrapper, command]).status, command).toBe(2);
    }
    const allowed = spawnSync('/bin/sh', [wrapper, 'echo-env'], { encoding: 'utf8' });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('profile=server-app');
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-056] the worker row shows a refused tick and withholds the token', async () => {
    installCli(STUB_BOARD, 'TICK_STATUS=refused\nTICK_MESSAGE="wrong machine for abm_Leaky123"');
    const session = await connected();

    await untilRow(session, (text) => text.startsWith('refused'));

    expect(workerRow(session)?.text).toBe('refused — wrong machine for [redacted]');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-043] the real CLI publishes a recipe the app reads', async (context) => {
    if (!existsSync(REAL_CLI)) {
      context.skip('the CLI is not built: run `pnpm --filter @rumo/cli build`');
    }
    installCli(REAL_CLI, '');
    writeSettings(root, { port, workerPath: [dirname(process.execPath)] });
    const session = start();
    await apiRunning(session);

    const answer = await act(
      session,
      `connect-worker abm_good abk1_${'A'.repeat(43)}`,
      'connect-worker',
    );

    expect(answer['ok']).toBe(false);
    expect(String(answer['message'])).not.toMatch(/recipe/i);
    expect(String(answer['message'])).not.toContain('abk1_AAAA');
    expect(String(answer['message'])).not.toMatch(/not valid/);
    expect(stored()).toEqual({});
    session.send('quit');
    await session.closed;
  });
});
