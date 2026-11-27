import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { controlClient } from '../src/fixtures/control.js';
import {
  LOGIN_ONLY_VARIABLES,
  SETTINGS_USER,
  serverAppEnv,
  startServerAppLayout,
  type ServerAppLayout,
} from '../src/fixtures/server-app-layout.js';
import { E2E_ROOT } from '../src/harness/paths.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');
const originalBin = process.env.RUMO_API_BIN;

describe('serverAppEnv', () => {
  it('runs no-login as the settings user with PGlite under the root', () => {
    const env = serverAppEnv({ root: '/work/root' });
    expect(env).toMatchObject({
      AUTH_MODE: 'no-login',
      NO_LOGIN_USER: SETTINGS_USER,
      DATABASE_URL: 'pglite:///work/root/db',
      CONTROL_SOCKET: '/work/root/ctl.sock',
      REQUEST_SIGNATURE: 'off',
    });
    expect(env.ALLOWED_HOSTS).toBe('127.0.0.1,localhost');
    expect(env.WEB_ROOT).toBeUndefined();
  });

  it('sets no login-only variable', () => {
    const env = serverAppEnv({ root: '/r', remoteHosts: ['box.example.test'], webRoot: '/web' });
    for (const name of LOGIN_ONLY_VARIABLES) expect(env).not.toHaveProperty(name);
    expect(env.WEB_ROOT).toBe('/web');
  });

  it('adds remote hosts and turns the signature on for them', () => {
    const env = serverAppEnv({ root: '/r', remoteHosts: ['box.example.test'] });
    expect(env.ALLOWED_HOSTS).toBe('127.0.0.1,localhost,box.example.test');
    expect(env.REQUEST_SIGNATURE).toBe('on');
  });
});

describe('startServerAppLayout', () => {
  let layout: ServerAppLayout | null = null;

  afterEach(async () => {
    await layout?.stop();
    layout = null;
    if (originalBin === undefined) delete process.env.RUMO_API_BIN;
    else process.env.RUMO_API_BIN = originalBin;
  });

  it('starts the API from a cleared environment and puts the CLI overrides under one root', async () => {
    process.env.RUMO_API_BIN = fakeApi;
    process.env.OIDC_ISSUER = 'must-not-leak';
    try {
      layout = await startServerAppLayout({ remoteHosts: ['box.example.test'] });
    } finally {
      delete process.env.OIDC_ISSUER;
    }
    const keys = (await (await fetch(`${layout.url}/env`)).json()) as string[];
    expect(keys).toEqual(
      expect.arrayContaining([
        'AUTH_MODE',
        'NO_LOGIN_USER',
        'ALLOWED_HOSTS',
        'CONTROL_SOCKET',
        'DATABASE_URL',
        'PORT',
      ]),
    );
    expect(keys).not.toContain('OIDC_ISSUER');
    for (const name of LOGIN_ONLY_VARIABLES) expect(keys).not.toContain(name);
    expect(layout.api.env.ALLOWED_HOSTS).toBe('127.0.0.1,localhost,box.example.test');
    expect(layout.api.env.DATABASE_URL).toBe(`pglite://${path.join(layout.root, 'db')}`);

    const overrides = [
      layout.cliEnv.RUMO_CONFIG_DIR,
      layout.cliEnv.RUMO_STATE_DIR,
      layout.cliEnv.RUMO_RUN_DIR,
    ];
    expect(overrides).toHaveLength(3);
    for (const directory of overrides) {
      expect(directory?.startsWith(`${layout.root}${path.sep}`)).toBe(true);
    }
    expect(layout.cliEnv.HOME).toContain(layout.root);
  });

  it('restarts the API on the same port and root', async () => {
    process.env.RUMO_API_BIN = fakeApi;
    layout = await startServerAppLayout();
    const { url, root } = layout;
    await layout.restartApi();
    expect(layout.url).toBe(url);
    expect(layout.root).toBe(root);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});

describe('controlClient', () => {
  it('posts each command to the socket and reads the pair code', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-ctl-'));
    const socketPath = path.join(dir, 'c.sock');
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(
        request.url === '/pair-code' ? JSON.stringify({ code: 'ABCD-2345' }) : '{"ok":true}',
      );
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const control = controlClient(socketPath);
      expect(await control.pairCode()).toBe('ABCD-2345');
      expect((await control.hold()).body).toEqual({ ok: true });
      await control.resume();
      await control.status();
      expect(seen).toEqual(['POST /pair-code', 'POST /hold', 'POST /resume', 'POST /status']);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects when the socket is not there', async () => {
    await expect(controlClient('/nonexistent/c.sock').status()).rejects.toThrow();
  });
});
