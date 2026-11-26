import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeApi, fakeControlSocket } from './backup-support.js';
import {
  binary,
  type Event,
  FAST_TIMINGS,
  freePort,
  launch,
  prepareResources,
  type Resources,
  type Session,
  SKIP_REASON,
  stub,
  until,
  writeSettings,
} from './support.js';

interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
}

interface Menu {
  type: 'menu';
  items: MenuItem[];
  badge: string | null;
  tooltip: string;
  busy: string[];
}

const ORDER = [
  'open-board',
  'api-status',
  'worker-status',
  'last-backup',
  'versions',
  'restart-server',
  'back-up-now',
  'restart-worker',
  'disconnect-worker',
  'check-worker',
  'open-logs',
  'open-settings',
  'connect-worker',
  'pair-device',
  'set-up',
  'quit',
];

const BUNDLE_ID = 'dev.mloureiro.agent-board-client';

describe('tray menu, handover and pairing through the headless runner', () => {
  let scratch: string;
  let root: string;
  let port: number;
  let resources: Resources;
  const sessions: Session[] = [];
  const fakes: FakeApi[] = [];

  beforeEach(async (context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    scratch = mkdtempSync(join(tmpdir(), 'server-app-tray-'));
    root = join(scratch, 'root');
    port = await freePort();
    resources = prepareResources(scratch);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    for (const fake of fakes.splice(0)) await fake.close();
    const pidFile = join(root, 'run/api.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8').split('\n')[0]), 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  function start(extra: Record<string, string> = {}): Session {
    const session = launch(root, {
      AGENT_BOARD_SERVER_RESOURCES: resources.dir,
      AGENT_BOARD_SUPERVISION_TIMINGS: FAST_TIMINGS,
      ...extra,
    });
    sessions.push(session);
    return session;
  }

  async function ask(session: Session, line: string, type: string): Promise<Event> {
    const before = session.events.length;
    session.send(line);
    await until(() => session.events.slice(before).some((event) => event['type'] === type), line);
    return session.events.slice(before).find((event) => event['type'] === type) as Event;
  }

  async function menuOf(session: Session): Promise<Menu> {
    return (await ask(session, 'menu', 'menu')) as unknown as Menu;
  }

  async function untilMenu(
    session: Session,
    condition: (menu: Menu) => boolean,
    what: string,
  ): Promise<Menu> {
    let latest: Menu | undefined;
    await until(async () => {
      latest = await menuOf(session);
      return condition(latest);
    }, what);
    return latest as Menu;
  }

  const apiRunning = (menu: Menu): boolean =>
    menu.items.find((item) => item.id === 'api-status')?.label === 'API: Running';

  async function actionAnswer(session: Session, line: string, action: string): Promise<Event> {
    const before = session.events.length;
    session.send(line);
    await until(
      () =>
        session.events
          .slice(before)
          .some((event) => event['type'] === 'action' && event['action'] === action),
      `the ${action} answer`,
    );
    return session.events
      .slice(before)
      .find((event) => event['type'] === 'action' && event['action'] === action) as Event;
  }

  function appLog(): string {
    return readFileSync(join(root, 'logs/app.log'), 'utf8');
  }

  function opener(exitWhenBundle: number): { program: string; calls: () => string[][] } {
    const program = join(scratch, 'open-recorder.sh');
    const record = join(scratch, 'open-calls.txt');
    writeFileSync(
      program,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\nif [ "$1" = "-b" ]; then exit ${exitWhenBundle}; fi\nexit 0\n`,
    );
    chmodSync(program, 0o755);
    return {
      program,
      calls: () =>
        existsSync(record)
          ? readFileSync(record, 'utf8')
              .split('\n')
              .filter((line) => line !== '')
              .map((line) => line.split(' '))
          : [],
    };
  }

  it('[server-app-011] the menu lists the items in the catalogue order and the status rows', async () => {
    writeSettings(root, { port });
    const session = start();
    const menu = await untilMenu(session, apiRunning, 'the API running');

    expect(menu.items.map((item) => item.id)).toEqual(ORDER);
    const labels = Object.fromEntries(menu.items.map((item) => [item.id, item.label]));
    expect(labels).toMatchObject({
      'open-board': 'Open board',
      'worker-status': 'Worker not connected',
      'last-backup': 'Last backup: never',
      'restart-server': 'Restart server',
      'back-up-now': 'Back up now',
      'restart-worker': 'Restart worker',
      'disconnect-worker': 'Disconnect worker',
      'check-worker': 'Check worker',
      'open-logs': 'Open logs folder',
      'open-settings': 'Open settings file',
      'connect-worker': 'Connect worker…',
      'pair-device': 'Pair a device…',
      'set-up': 'Set up…',
      quit: 'Quit',
    });
    expect(menu.badge).toBeNull();
    expect(menu.tooltip).toBe('Agent Board Server');
    session.send('quit');
    expect(await session.closed).toBe(0);
  });

  it('[server-app-012] Open board, Back up now and Connect follow the API; the worker items wait for the worker', async () => {
    writeSettings(root, { port });
    resources.configure('startup_delay_ms=1500');
    const session = start();
    const starting = await menuOf(session);
    const enabledOf = (menu: Menu): string[] =>
      menu.items.filter((item) => item.enabled).map((item) => item.id);

    expect(apiRunning(starting)).toBe(false);
    expect(enabledOf(starting)).toEqual([
      'restart-server',
      'open-logs',
      'open-settings',
      'set-up',
      'quit',
    ]);
    const running = await untilMenu(session, apiRunning, 'the API running');
    expect(enabledOf(running)).toEqual([
      'open-board',
      'restart-server',
      'back-up-now',
      'open-logs',
      'open-settings',
      'connect-worker',
      'set-up',
      'quit',
    ]);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-013] while a backup runs only Open board, Connect worker and Quit stay enabled and other clicks are refused and logged', async () => {
    writeSettings(root, { port });
    mkdirSync(join(root, 'data/base'), { recursive: true });
    writeFileSync(join(root, 'data/PG_VERSION'), '17');
    writeFileSync(join(root, 'data/base/1'), 'rows');
    writeFileSync(join(root, 'data-schema-version'), 'stub-1\n');
    const session = start();
    await untilMenu(session, apiRunning, 'the API running');
    const fake = await fakeControlSocket(root, { holdDelayMs: 1500 });
    fakes.push(fake);

    session.send('backup-now');
    const busy = await untilMenu(session, (menu) => menu.busy.length > 0, 'the busy lock');
    expect(busy.busy).toEqual(['backup']);
    expect(busy.items.filter((item) => item.enabled).map((item) => item.id)).toEqual([
      'open-board',
      'connect-worker',
      'set-up',
      'quit',
    ]);
    expect(busy.items.find((item) => item.id === 'last-backup')?.label).toBe(
      'Last backup: backing up…',
    );

    const refused = await actionAnswer(session, 'restart-server', 'restart-server');
    expect(refused).toMatchObject({ ok: false, message: 'a backup is running' });
    const again = await actionAnswer(session, 'backup-now', 'backup-now');
    expect(again).toMatchObject({ ok: false, message: 'a backup is running' });
    expect(appLog()).toContain('refused restart-server: a backup is running');

    await until(
      () =>
        session.events.some((event) => event['action'] === 'backup-now' && event['ok'] === true),
      'the backup to finish',
    );
    const idle = await untilMenu(session, (menu) => menu.busy.length === 0, 'the lock to lift');
    expect(idle.items.find((item) => item.id === 'restart-server')?.enabled).toBe(true);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-015] a failing row puts the mark on the tray with its text, and recovery clears it', async () => {
    writeSettings(root, { port });
    const program = join(resources.dir, 'api/schema-version');
    rmSync(program);
    const session = start();

    const failing = await untilMenu(session, (menu) => menu.badge !== null, 'the mark');
    expect(failing.badge).toBe('!');
    expect(failing.tooltip).toMatch(/^Blocked: /);
    expect(failing.items.find((item) => item.id === 'api-status')?.label).toContain(
      failing.tooltip,
    );

    writeFileSync(program, 'stub-1\n');
    session.send('restart-server');
    const recovered = await untilMenu(
      session,
      (menu) => menu.badge === null && apiRunning(menu),
      'the mark to clear',
    );
    expect(recovered.tooltip).toBe('Agent Board Server');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-016] the version line reads the bundled versions and says unknown otherwise', async () => {
    writeSettings(root, { port });
    mkdirSync(join(resources.dir, 'cli'), { recursive: true });
    writeFileSync(join(resources.dir, 'api/version'), '3.1.4\n');
    const session = start();
    const menu = await menuOf(session);
    const line = menu.items.find((item) => item.id === 'versions') as MenuItem;
    expect(line.enabled).toBe(false);
    expect(line.label).toMatch(/^server app \S+ · API 3\.1\.4 · CLI unknown$/);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-014] Open board hands the server URL to the client app with the contract link', async () => {
    writeSettings(root, { port });
    const recorder = opener(0);
    const session = start({ AGENT_BOARD_OPEN_PROGRAM: recorder.program });
    await untilMenu(session, apiRunning, 'the API running');

    const answer = await actionAnswer(session, 'open-board', 'open-board');

    const url = `http://127.0.0.1:${port}/`;
    const link = `agentboard://open?v=1&url=${encodeURIComponent(url)}`;
    expect(answer).toMatchObject({
      ok: true,
      target: 'client-app',
      commands: [['open', '-b', BUNDLE_ID, link]],
    });
    expect(recorder.calls()).toEqual([['-b', BUNDLE_ID, link]]);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-014] Open board falls back to the default browser when the client app is absent', async () => {
    writeSettings(root, { port });
    const recorder = opener(1);
    const session = start({ AGENT_BOARD_OPEN_PROGRAM: recorder.program });
    await untilMenu(session, apiRunning, 'the API running');

    const answer = await actionAnswer(session, 'open-board', 'open-board');

    const url = `http://127.0.0.1:${port}/`;
    expect(answer).toMatchObject({ ok: true, target: 'browser' });
    expect(recorder.calls()).toEqual([
      ['-b', BUNDLE_ID, `agentboard://open?v=1&url=${encodeURIComponent(url)}`],
      [url],
    ]);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-014] Open board is refused while the API is not running and runs nothing', async () => {
    writeSettings(root, { port });
    rmSync(join(resources.dir, 'api/agent-board-api'));
    const recorder = opener(0);
    const session = start({ AGENT_BOARD_OPEN_PROGRAM: recorder.program });

    const answer = await actionAnswer(session, 'open-board', 'open-board');

    expect(answer).toMatchObject({ ok: false, message: 'the API is not running' });
    expect(recorder.calls()).toEqual([]);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-090] Pair a device shows the control channel code with its expiry and never logs it', async () => {
    writeSettings(root, { port, requestSignature: true });
    const session = start();
    await untilMenu(session, apiRunning, 'the API running');
    const fake = await fakeControlSocket(root, { pairCode: 'WXYZ-2345' });
    fakes.push(fake);

    const menu = await menuOf(session);
    expect(menu.items.find((item) => item.id === 'pair-device')?.enabled).toBe(true);
    const before = Date.now();
    const answer = await ask(session, 'pair-device', 'pair-code');

    expect(fake.commands).toEqual(['pair-code']);
    expect(answer).toMatchObject({ type: 'pair-code', code: 'WXYZ-2345', validForSeconds: 600 });
    const expires = Date.parse(answer['expiresAt'] as string);
    expect(expires).toBeGreaterThan(before + 590_000);
    expect(expires).toBeLessThan(Date.now() + 610_000);
    session.send('quit');
    await session.closed;
    expect(appLog()).toContain('pairing code issued');
    for (const name of ['app.log', 'api.log']) {
      const file = join(root, 'logs', name);
      if (existsSync(file)) expect(readFileSync(file, 'utf8')).not.toContain('WXYZ-2345');
    }
  });

  it('[server-app-090] Pair a device is refused with a clear message while the request signature is off', async () => {
    writeSettings(root, { port });
    const session = start();
    const menu = await untilMenu(session, apiRunning, 'the API running');
    expect(menu.items.find((item) => item.id === 'pair-device')?.enabled).toBe(false);

    const answer = await actionAnswer(session, 'pair-device', 'pair-device');

    expect(answer['ok']).toBe(false);
    expect(answer['message']).toContain('requestSignature');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-090] Pair a device is refused while remote access is on', async () => {
    writeSettings(root, { port, publicUrl: 'https://board.example.net' });
    const session = start();
    const menu = await untilMenu(session, apiRunning, 'the API running');
    expect(menu.items.find((item) => item.id === 'pair-device')?.enabled).toBe(false);

    const answer = await actionAnswer(session, 'pair-device', 'pair-device');

    expect(answer['ok']).toBe(false);
    expect(answer['message']).toContain('remote access');
    session.send('quit');
    await session.closed;
  });

  it('[server-app-090] an API refusal reaches the caller and no code is shown', async () => {
    writeSettings(root, { port, requestSignature: true });
    const session = start();
    await untilMenu(session, apiRunning, 'the API running');
    const fake = await fakeControlSocket(root, { pairRefusal: 'the board is on hold' });
    fakes.push(fake);

    const answer = await actionAnswer(session, 'pair-device', 'pair-device');

    expect(answer).toMatchObject({ ok: false, message: 'the board is on hold' });
    expect(session.events.some((event) => event['type'] === 'pair-code')).toBe(false);
    session.send('quit');
    await session.closed;
  });

  it('[server-app-022] every tray action answers through the headless runner', async () => {
    writeSettings(root, { port, requestSignature: true });
    const recorder = opener(0);
    const session = start({ AGENT_BOARD_OPEN_PROGRAM: recorder.program });
    await untilMenu(session, apiRunning, 'the API running');
    const fake = await fakeControlSocket(root, { pairCode: 'WXYZ-2345' });
    fakes.push(fake);

    expect((await ask(session, 'pair-device', 'pair-code'))['code']).toBe('WXYZ-2345');
    const answers: Record<string, Event> = {};
    for (const action of [
      'open-board',
      'open-logs',
      'open-settings',
      'restart-server',
      'restart-worker',
      'disconnect-worker',
      'check-worker',
      'connect-worker',
    ]) {
      answers[action] = await actionAnswer(
        session,
        action === 'connect-worker' ? 'connect-worker only-one' : action,
        action,
      );
    }
    expect(answers['open-board']).toMatchObject({ ok: true });
    expect(answers['open-logs']).toMatchObject({ ok: true });
    expect(answers['open-settings']).toMatchObject({ ok: true });
    expect(answers['restart-server']).toMatchObject({ ok: true });
    for (const worker of ['restart-worker', 'disconnect-worker', 'check-worker']) {
      expect(answers[worker]).toMatchObject({ ok: false, message: 'Worker not connected' });
    }
    expect(answers['connect-worker']).toMatchObject({
      ok: false,
      message: 'connect-worker needs a token and a data key',
    });
    expect(await ask(session, 'state', 'state')).toMatchObject({ type: 'state' });
    expect(await ask(session, 'menu', 'menu')).toMatchObject({ type: 'menu' });
    expect(await ask(session, 'bogus', 'error')).toMatchObject({
      message: 'unknown action: bogus',
    });

    session.send('quit');
    expect(await session.closed).toBe(0);
    expect(session.events.at(-1)).toEqual({ type: 'quit' });
  });
});
