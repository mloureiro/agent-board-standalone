import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createConnection } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledApp, missing, startApp, type RealApp } from './real.js';

const CONTRACT = { 'x-board-contract': '1' };
const SHELL_ADDED = ['PWD', 'SHLVL', '_', 'OLDPWD'];

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 3000 });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function httpsAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const outgoing = request(
      { host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 3000 },
      () => resolve(true),
    );
    outgoing.on('error', () => resolve(false));
    outgoing.on('timeout', () => {
      outgoing.destroy();
      resolve(false);
    });
    outgoing.end();
  });
}

describe('the network surface of the real API', { timeout: 120_000 }, () => {
  const apps: RealApp[] = [];

  beforeEach((context) => {
    if (missing !== undefined) context.skip(missing);
  });

  afterEach(() => {
    for (const app of apps.splice(0)) app.dispose();
  });

  async function started(settings: Record<string, unknown> = {}): Promise<RealApp> {
    const app = await startApp({ bundle: bundledApp !== undefined, settings });
    apps.push(app);
    return app;
  }

  it('[server-app-073] the API binds 127.0.0.1:<port> itself and no other address answers', async () => {
    const app = await started();
    const listing = spawnSync('lsof', ['-nP', `-iTCP:${app.port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).stdout;

    expect(listing).toContain(`127.0.0.1:${app.port} (LISTEN)`);
    expect(listing).not.toMatch(/\*:\d+ \(LISTEN\)|\[::\]|0\.0\.0\.0/);
    expect(await connects('127.0.0.1', app.port)).toBe(true);
    const lan = lanAddress();
    if (lan !== undefined) expect(await connects(lan, app.port)).toBe(false);
  });

  it('[server-app-074] the API runs from exactly the local configuration in a cleared environment', async () => {
    const app = await startApp({ dumpApiEnvironment: true });
    apps.push(app);

    const dump = readFileSync(join(app.scratch, 'api-env.txt'), 'utf8').trim().split('\n');
    const environment = Object.fromEntries(
      dump.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    ) as Record<string, string>;
    for (const added of SHELL_ADDED) delete environment[added];

    expect(environment).toEqual({
      AUTH_MODE: 'no-login',
      NO_LOGIN_USER: 'tester',
      DATABASE_URL: `pglite://${app.root}/data`,
      HOST: '127.0.0.1',
      PORT: String(app.port),
      ALLOWED_HOSTS: 'localhost,127.0.0.1,[::1]',
      WEB_ROOT: join(app.scratch, 'resources/web'),
      CONTROL_SOCKET: join(app.root, 'run/api.sock'),
      ACCESS_LOG: join(app.root, 'logs/access.log'),
    });
    const me = await fetch(`${app.url}/api/client/me`, { headers: CONTRACT });
    expect(await me.json()).toMatchObject({ username: 'tester' });
  });

  it('[server-app-083] there is no HTTPS on loopback and unsigned requests are accepted with request signature off', async () => {
    const app = await started();

    expect(await httpsAnswers(app.port)).toBe(false);
    const me = await fetch(`${app.url}/api/client/me`, { headers: CONTRACT });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'tester' });
  });

  it('[server-app-083] with request signature on an unsigned or wrongly signed request is refused', async () => {
    const app = await started({ requestSignature: true });

    const unsigned = await fetch(`${app.url}/api/client/me`, { headers: CONTRACT });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.text()).toContain('signed requests');
    const forged = await fetch(`${app.url}/api/client/me`, {
      headers: {
        ...CONTRACT,
        'x-board-key': 'a'.repeat(16),
        'x-board-ts': String(Math.floor(Date.now() / 1000)),
        'x-board-nonce': 'b'.repeat(22),
        'x-board-sig': 'c'.repeat(86),
      },
    });
    expect(forged.status).toBe(401);
    expect((await fetch(`${app.url}/healthz`)).status).toBe(200);
  });
});
