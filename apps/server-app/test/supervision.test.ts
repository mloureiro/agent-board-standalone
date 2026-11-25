import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  binary,
  FAST_TIMINGS,
  freePort,
  isAlive,
  launch,
  prepareResources,
  type Resources,
  type Session,
  SKIP_REASON,
  stub,
  until,
  writeSettings,
} from './support.js';

interface Supervision {
  api: { state: string; text: string };
  worker: { state: string; text: string };
  gaveUp: { api: boolean; worker: boolean };
}

describe('supervision through the headless runner', () => {
  let scratch: string;
  let root: string;
  let port: number;
  let resources: Resources;
  const sessions: Session[] = [];
  const servers: Server[] = [];

  beforeEach(async (context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    scratch = mkdtempSync(join(tmpdir(), 'server-app-supervision-'));
    root = join(scratch, 'root');
    port = await freePort();
    writeSettings(root, { port });
    resources = prepareResources(scratch);
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) session.child.kill('SIGKILL');
    for (const server of servers.splice(0)) server.close();
    try {
      for (const pid of apiPids()) process.kill(pid, 'SIGKILL');
    } catch {
      // nothing left to clean up
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  function apiPids(): number[] {
    const file = join(root, 'run/api.pid');
    return existsSync(file) ? [Number(readFileSync(file, 'utf8').split('\n')[0])] : [];
  }

  const apiPid = (): number | undefined => apiPids()[0];

  function start(): Session {
    const session = launch(root, {
      AGENT_BOARD_SERVER_RESOURCES: resources.dir,
      AGENT_BOARD_SUPERVISION_TIMINGS: FAST_TIMINGS,
    });
    sessions.push(session);
    return session;
  }

  function supervision(session: Session): Supervision | undefined {
    const states = session.events.filter((event) => event['type'] === 'state');
    return states.at(-1)?.['supervision'] as Supervision | undefined;
  }

  async function untilSupervision(
    session: Session,
    condition: (value: Supervision) => boolean,
    what: string,
  ): Promise<Supervision> {
    await until(() => {
      session.send('state');
      const value = supervision(session);
      return value !== undefined && condition(value);
    }, what);
    return supervision(session) as Supervision;
  }

  const healthz = async (): Promise<number> =>
    (await fetch(`http://127.0.0.1:${port}/healthz`)).status;

  async function running(session: Session): Promise<void> {
    await untilSupervision(session, (value) => value.api.state === 'running', 'the API running');
  }

  it('[server-app-024] the API starts under supervision and answers /healthz', async () => {
    const session = start();
    await running(session);

    expect(await healthz()).toBe(200);
    expect(supervision(session)?.worker).toEqual({ state: 'off', text: 'Not set up' });
    session.send('quit');
    expect(await session.closed).toBe(0);
    expect(session.events.at(-1)).toEqual({ type: 'quit' });
  });

  it('[server-app-028] a killed API is restarted and /healthz answers again', async () => {
    const session = start();
    await running(session);
    const killed = apiPid() as number;

    process.kill(killed, 'SIGKILL');
    await until(() => apiPid() !== undefined && apiPid() !== killed, 'a new API pid');
    await running(session);

    expect(isAlive(killed)).toBe(false);
    expect(await healthz()).toBe(200);
    const states = session.events
      .filter((event) => event['type'] === 'state')
      .map((event) => (event['supervision'] as Supervision).api.state);
    expect(states).toContain('restarting');
  });

  it('[server-app-025] a fourth crash gives up and Restart server clears it [server-app-017]', async () => {
    resources.configure('health=none\ncrash_after_ms=20');
    const session = start();
    const gaveUp = await untilSupervision(session, (value) => value.gaveUp.api, 'the give-up');
    expect(gaveUp.api.state).toBe('gave-up');
    expect(gaveUp.api.text).toContain('Gave up');
    expect(gaveUp.worker.state).toBe('off');

    resources.configure('');
    session.send('restart-server');
    const recovered = await untilSupervision(
      session,
      (value) => value.api.state === 'running',
      'the API running again',
    );
    expect(recovered.gaveUp.api).toBe(false);
    expect(await healthz()).toBe(200);
  });

  it('[server-app-034] a port in use shows on the API row and the app stays up', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
    const session = start();

    const blocked = await untilSupervision(
      session,
      (value) => value.api.state === 'failed',
      'the failed API row',
    );
    expect(blocked.api.text).toBe(`Port ${port} in use; change port in settings.json`);
    expect(isAlive(session.child.pid as number)).toBe(true);
    expect(apiPid()).toBeUndefined();

    session.send('quit');
    expect(await session.closed).toBe(0);
  });

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    '[server-app-032] %s stops the API with its whole group and exits',
    async (signal) => {
      resources.configure(`grandchild_pid_file=${join(scratch, 'grandchild.pid')}`);
      const session = start();
      await running(session);
      await until(() => existsSync(join(scratch, 'grandchild.pid')), 'the grandchild');
      const api = apiPid() as number;
      const grandchild = Number(readFileSync(join(scratch, 'grandchild.pid'), 'utf8'));

      session.child.kill(signal);

      expect(await session.closed).toBe(0);
      expect(isAlive(api)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
      expect(session.events.at(-1)).toEqual({ type: 'quit' });
    },
  );

  it('[server-app-032] a SIGTERM during start stops the API that is still starting', async () => {
    resources.configure('startup_delay_ms=8000');
    const session = start();
    await until(() => apiPid() !== undefined, 'the API process');
    const api = apiPid() as number;

    session.child.kill('SIGTERM');

    expect(await session.closed).toBe(0);
    expect(isAlive(api)).toBe(false);
  });

  it('[server-app-033] quit with an API that ignores SIGTERM ends after the grace period', async () => {
    resources.configure('ignore_term=1');
    const session = start();
    await running(session);
    const api = apiPid() as number;

    const started = Date.now();
    session.send('quit');
    expect(await session.closed).toBe(0);

    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(isAlive(api)).toBe(false);
  });

  it('[server-app-030] an orphan left by a crashed app is terminated at the next start', async () => {
    const program = join(resources.dir, 'api/agent-board-api');
    writeFileSync(join(scratch, 'orphan.conf'), 'health=none\nignore_term=1\n');
    const left = spawn(program, [], {
      detached: true,
      stdio: 'ignore',
      env: { STUB_CONFIG: join(scratch, 'orphan.conf') },
    });
    left.unref();
    const orphan = left.pid as number;
    expect(isAlive(orphan)).toBe(true);
    mkdirSync(join(root, 'run'), { recursive: true });
    writeFileSync(join(root, 'run/api.pid'), `${orphan}\n${program}\n`);

    const session = start();
    await running(session);

    expect(isAlive(orphan)).toBe(false);
    expect(apiPid()).not.toBe(orphan);
    const log = readFileSync(join(root, 'logs/app.log'), 'utf8');
    expect(log).toContain('orphan sweep');
  });

  it('[server-app-031] a second launch does not start a second API', async () => {
    const first = start();
    await running(first);
    const api = apiPid();

    const second = start();
    expect(await second.closed).toBe(0);

    expect(apiPid()).toBe(api);
    expect(await healthz()).toBe(200);
  });

  it('[server-app-003] nothing in the app tree listens beyond 127.0.0.1 or [::1]', async () => {
    const session = start();
    await running(session);
    const pids = [session.child.pid as number, apiPid() as number].join(',');

    const listing = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids], {
      encoding: 'utf8',
    }).stdout;
    const addresses = listing
      .split('\n')
      .slice(1)
      .filter((line) => line.includes('(LISTEN)'))
      .map((line) => line.split(/\s+/).at(-2) as string);

    expect(addresses).toContain(`127.0.0.1:${port}`);
    for (const address of addresses) expect(address).toMatch(/^(127\.0\.0\.1|\[::1\]):\d+$/);
  });

  it('[server-app-022] actions of later iterations are refused with a clear error line', async () => {
    const session = start();
    session.send('backup-now');
    await until(() => session.events.some((event) => event['type'] === 'error'), 'the error line');
    expect(session.events.find((event) => event['type'] === 'error')).toMatchObject({
      action: 'backup-now',
      message: 'backup-now is not implemented in this build',
    });
    session.send('quit');
    await session.closed;
  });

  it('[server-app-032] the app leaves no child behind when its input ends', async () => {
    const session = start();
    await running(session);
    const api = apiPid() as number;

    session.child.stdin.end();

    expect(await session.closed).toBe(0);
    expect(isAlive(api)).toBe(false);
  });
});

describe('supervision with the real API executable', () => {
  const real = join(import.meta.dirname, '../../api/dist/agent-board-api');
  let scratch: string;
  let session: Session | undefined;

  beforeEach((context) => {
    if (binary === undefined || stub === undefined) context.skip(SKIP_REASON);
    if (!existsSync(real))
      context.skip(
        'the API executable is not built: run `pnpm --filter @agent-board/api build:executable`',
      );
    scratch = mkdtempSync(join(tmpdir(), 'server-app-real-'));
  });

  afterEach(() => {
    session?.child.kill('SIGKILL');
    session = undefined;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('[server-app-028] the real API starts from a cleared environment and stops with the app', async () => {
    const root = join(scratch, 'root');
    const port = await freePort();
    writeSettings(root, { port });
    const dir = join(scratch, 'resources');
    mkdirSync(join(dir, 'api'), { recursive: true });
    mkdirSync(join(dir, 'web'), { recursive: true });
    copyFileSync(real, join(dir, 'api/agent-board-api'));
    writeFileSync(join(dir, 'web/index.html'), '<html></html>');

    session = launch(root, { AGENT_BOARD_SERVER_RESOURCES: dir });
    const current = session;
    await until(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200;
        } catch {
          return false;
        }
      },
      'the real API answering /healthz',
      60,
    );
    const pid = Number(readFileSync(join(root, 'run/api.pid'), 'utf8').split('\n')[0]);

    current.child.kill('SIGTERM');
    expect(await current.closed).toBe(0);
    expect(isAlive(pid)).toBe(false);
  });
});
