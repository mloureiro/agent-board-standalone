import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startApi, type ApiHandle } from '../src/harness/api.js';
import { createPgliteDatabase } from '../src/harness/database.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { createTmp, type Tmp } from '../src/harness/tmp.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');

describe('startApi', () => {
  const stops: (() => Promise<void> | void)[] = [];
  const originalBin = process.env.AGENT_BOARD_API_BIN;

  function setup(): Tmp {
    process.env.AGENT_BOARD_API_BIN = fakeApi;
    const tmp = createTmp('api-test');
    stops.push(() => tmp.remove());
    return tmp;
  }

  async function start(tmp: Tmp, extra: Record<string, string> = {}, readyTimeoutMs?: number) {
    const handle = await startApi({
      tmp,
      database: createPgliteDatabase(tmp),
      auth: 'no-login',
      env: extra,
      ...(readyTimeoutMs === undefined ? {} : { readyTimeoutMs }),
    });
    stops.unshift(() => handle.stop());
    return handle;
  }

  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
    if (originalBin === undefined) delete process.env.AGENT_BOARD_API_BIN;
    else process.env.AGENT_BOARD_API_BIN = originalBin;
  });

  it('parses the readiness line and answers requests', async () => {
    const api = await start(setup());
    expect(api.url).toBe(`http://127.0.0.1:${api.port}`);
    expect(await (await fetch(`${api.url}/healthz`)).json()).toEqual({ status: 'ok' });
  });

  it('reports the log tail when the API never announces itself', async () => {
    const tmp = setup();
    await expect(start(tmp, { FAKE_API_SILENT: '1' }, 600)).rejects.toThrow(
      /not ready after 600 ms[\s\S]*fake api started without announcing/,
    );
  });

  it('starts the child from a cleared environment', async () => {
    process.env.E2E_LEAK_CHECK = 'leaked';
    try {
      const api = await start(setup());
      const keys = (await (await fetch(`${api.url}/env`)).json()) as string[];
      expect(keys).not.toContain('E2E_LEAK_CHECK');
      expect(keys).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'AUTH_MODE', 'HOST', 'PORT', 'AGENT_BOARD_E2E']),
      );
    } finally {
      delete process.env.E2E_LEAK_CHECK;
    }
  });

  it('writes the log to <tmp>/api.log', async () => {
    const tmp = setup();
    const api = await start(tmp);
    expect(api.logPath).toBe(tmp.path('api.log'));
    expect(readFileSync(api.logPath, 'utf8')).toContain('"listening"');
  });

  it('keeps the port and the data dir across restart()', async () => {
    const tmp = setup();
    const api: ApiHandle = await start(tmp);
    const { port, url } = api;
    await api.restart();
    expect(api.port).toBe(port);
    expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ status: 'ok' });
    const starts = readFileSync(tmp.path('db', 'starts'), 'utf8').trim().split('\n');
    expect(starts).toHaveLength(2);
  });

  it('starts again with restart() after stop()', async () => {
    const tmp = setup();
    const api: ApiHandle = await start(tmp);
    await api.stop();
    await api.restart();
    expect(await (await fetch(`${api.url}/healthz`)).json()).toEqual({ status: 'ok' });
    await api.stop();
    const listening = readFileSync(api.logPath, 'utf8').match(/"listening"/g) ?? [];
    expect(listening).toHaveLength(2);
  });

  it('stops the child on stop()', async () => {
    const api = await start(setup());
    await api.stop();
    await expect(fetch(`${api.url}/healthz`)).rejects.toThrow();
    expect(existsSync(api.logPath)).toBe(true);
  });

  it('serves the login-mode configuration on localhost', async () => {
    const tmp = setup();
    const api = await startApi({
      tmp,
      database: createPgliteDatabase(tmp),
      auth: 'login',
    });
    stops.unshift(() => api.stop());
    expect(api.host).toBe('localhost');
    expect(api.env.PUBLIC_URL).toBe(`http://localhost:${api.port}`);
    expect(api.env.ALLOWED_HOSTS).toBe('localhost');
  });
});
