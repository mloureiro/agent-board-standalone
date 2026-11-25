import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anonymous, call, machineToken } from '../src/client/contract-client.js';
import { isPing, openEvents } from '../src/client/events.js';
import {
  patchVersion,
  startVersionProxy,
  type VersionProxy,
} from '../src/fixtures/version-proxy.js';
import { startApi, type ApiHandle } from '../src/harness/api.js';
import { createPgliteDatabase } from '../src/harness/database.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { createTmp, type Tmp } from '../src/harness/tmp.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');
const originalBin = process.env.AGENT_BOARD_API_BIN;
const token = machineToken(`abm_${'M'.repeat(43)}`);

let api: ApiHandle;
let tmp: Tmp;
let proxy: VersionProxy;

beforeAll(async () => {
  process.env.AGENT_BOARD_API_BIN = fakeApi;
  tmp = createTmp('version-proxy');
  api = await startApi({
    tmp,
    database: createPgliteDatabase(tmp),
    auth: 'no-login',
    env: { FAKE_API_FEATURES: JSON.stringify(['projects', 'forks']) },
  });
  proxy = await startVersionProxy({
    target: api.url,
    override: { contract: 7, minClient: { web: 7 }, features: ['projects', 'schedules'] },
  });
});

afterAll(async () => {
  await proxy.stop();
  await api.stop();
  tmp.remove();
  if (originalBin === undefined) delete process.env.AGENT_BOARD_API_BIN;
  else process.env.AGENT_BOARD_API_BIN = originalBin;
});

describe('version proxy', () => {
  it('rewrites the public version answer and leaves the rest of it alone', async () => {
    const real = await call(api, 'public.version', {}, anonymous);
    const proxied = await call(proxy, 'public.version', {}, anonymous);
    expect(real.body?.contract).toBe(1);
    expect(proxied.body).toMatchObject({
      contract: 7,
      minClient: { cli: 1, web: 7 },
      features: ['projects', 'schedules'],
      server: real.body?.server,
      modules: real.body?.modules,
    });
  });

  it('rewrites the version machine command', async () => {
    const real = await call(api, 'machine.version', {}, token);
    const proxied = await call(proxy, 'machine.version', {}, token);
    expect(real.body?.contract).toBe(1);
    expect(proxied.body).toMatchObject({ contract: 7, features: ['projects', 'schedules'] });
    expect(proxied.body?.owner).toBe(real.body?.owner);
  });

  it('passes every other path through unchanged', async () => {
    const real = await call(api, 'client.me', {}, anonymous);
    const proxied = await call(proxy, 'client.me', {}, anonymous);
    expect(proxied.status).toBe(real.status);
    expect(proxied.body).toEqual(real.body);
    const missing = await call(proxy, 'client.tasks.get', { id: 'x' }, anonymous);
    expect(missing.status).toBe(404);
    expect(missing.error?.code).toBe('not-found');
    const refused = await call(proxy, 'client.me', {}, anonymous, { omitContractHeader: true });
    expect(refused.status).toBe(412);
  });

  it('forwards the request headers and body to the target', async () => {
    await call(proxy, 'client.tasks.done', { id: 'task-9' }, anonymous, {
      headers: { 'x-extra': 'yes' },
    });
    const seen = (await (await fetch(`${api.url}/__last`)).json()) as {
      headers: Record<string, string>;
      body: string;
    };
    expect(seen.headers['x-extra']).toBe('yes');
    expect(JSON.parse(seen.body)).toEqual({ id: 'task-9' });
  });

  it('streams an event stream through before it ends', async () => {
    const stream = await openEvents(proxy, 'client.events', anonymous, {
      query: { project: 'hold' },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.nextEvent()).toEqual({ event: 'tasks', data: {} });
    expect((await stream.next()) !== null).toBe(true);
    expect(stream.items.some(isPing)).toBe(true);
    stream.close();
    await stream.closed;
  });

  it('records what it saw and changes the answer on demand', async () => {
    proxy.override({ contract: 3 });
    const answer = await call(proxy, 'public.version', {}, anonymous);
    expect(answer.body?.contract).toBe(3);
    expect(answer.body?.features).toEqual(['projects', 'forks']);
    expect(proxy.seen.some((entry) => entry.path === '/api/version' && entry.rewritten)).toBe(true);
    expect(proxy.seen.some((entry) => entry.path === '/api/client/me' && !entry.rewritten)).toBe(
      true,
    );
  });
});

describe('patchVersion', () => {
  it('adds and removes features around a base list', () => {
    expect(
      patchVersion({ features: ['a', 'b'] }, { addFeatures: ['c'], removeFeatures: ['a'] }),
    ).toEqual({ features: ['b', 'c'] });
  });

  it('merges minClient and leaves a non-object alone', () => {
    expect(patchVersion({ minClient: { cli: 1, web: 1 } }, { minClient: { cli: 4 } })).toEqual({
      minClient: { cli: 4, web: 1 },
    });
    expect(patchVersion('text', { contract: 2 })).toBe('text');
  });

  it('sets minServer only where the answer has one', () => {
    expect(patchVersion({ contract: 1 }, { minServer: 3 })).toEqual({ contract: 1 });
    expect(patchVersion({ minServer: 1 }, { minServer: 3 })).toEqual({ minServer: 3 });
  });
});
