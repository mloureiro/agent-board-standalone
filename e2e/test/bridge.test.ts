import path from 'node:path';
import vm from 'node:vm';

import { TOKEN_PATTERN, routes } from '@agent-board/contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createBridgeHost, refusedBridgePath, type BridgeHost } from '../src/fakes/bridge/host.js';
import { bridgeInitScript } from '../src/fakes/bridge/inject.js';
import type { AgentBoardBridge } from '../src/fakes/bridge/types.js';
import { startApi, type ApiHandle } from '../src/harness/api.js';
import { createPgliteDatabase } from '../src/harness/database.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { createTmp, type Tmp } from '../src/harness/tmp.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');
const originalBin = process.env.AGENT_BOARD_API_BIN;
const TOKEN_ANYWHERE = /(abs|abc|abm)_[A-Za-z0-9_-]{43}/;

let api: ApiHandle;
let tmp: Tmp;

beforeAll(async () => {
  process.env.AGENT_BOARD_API_BIN = fakeApi;
  tmp = createTmp('bridge');
  api = await startApi({ tmp, database: createPgliteDatabase(tmp), auth: 'no-login' });
});

afterAll(async () => {
  await api.stop();
  tmp.remove();
  if (originalBin === undefined) delete process.env.AGENT_BOARD_API_BIN;
  else process.env.AGENT_BOARD_API_BIN = originalBin;
});

interface SeenRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly url: string;
}

async function lastSeen(): Promise<SeenRequest> {
  return (await (await fetch(`${api.url}/__last`)).json()) as SeenRequest;
}

describe('refusedBridgePath', () => {
  it.each([
    ['/api/client/me', null],
    ['/healthz', null],
    ['/api/client/tasks/list?closed=true', null],
    ['/api/../etc', 'dot segment'],
    ['/api/%2E%2e/x', 'dot segment'],
    ['/api//client', 'empty segment'],
    ['//evil.test/api/x', 'path must start with a single /'],
    ['/api\\client', 'backslash'],
    ['/static/app.js', 'outside /api/'],
    ['/api/auth/handoff/finish', 'credential route'],
    ['/api/pair', 'credential route'],
    ['/api/client/machines/issue', 'credential route'],
    ['/api/client/passkeys/register', 'credential route'],
    ['/api/client/account/import', 'credential route'],
    ['/api/auth%2Fhandoff/finish', 'encoded separator'],
    ['/api/pair%5c', 'encoded separator'],
    ['/api/client/me?next=%2Fapi%2Fpair', null],
  ])('%s -> %s', (candidate, reason) => {
    expect(refusedBridgePath(candidate)).toBe(reason);
  });

  it.each(routes.filter((route) => route.issuesCredential === true).map((route) => route.path))(
    'refuses %s, which the contract marks as issuing a credential',
    (credentialPath) => {
      expect(refusedBridgePath(credentialPath)).toBe('credential route');
    },
  );
});

describe('bridge host', () => {
  let host: BridgeHost;
  let serverId: string;

  beforeEach(() => {
    host = createBridgeHost({ servers: [{ name: 'local', url: api.url }] });
    serverId = host.servers()[0]?.id as string;
  });

  const pageValues = (): readonly string[] => host.passedToPage;

  it('keeps the client token in Node after the hand-off finish', async () => {
    const answer = (await host.handle('request', {
      serverId,
      init: {
        method: 'POST',
        path: '/api/auth/handoff/start',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: 'c'.repeat(43) }),
      },
    })) as { body: string };
    const started = JSON.parse(answer.body) as { flow: string; code: string };
    expect(started).toEqual({ flow: 'flow-1', code: 'ABCD-2345' });
    const finished = await host.handle('handoff.finish', {
      serverId,
      flow: started.flow,
      verifier: 'v'.repeat(43),
    });
    expect(finished).toEqual({ status: 'signed-in' });
    expect(host.tokenFor(serverId)).toMatch(TOKEN_PATTERN);

    await host.handle('request', { serverId, init: { method: 'GET', path: '/api/client/me' } });
    expect((await lastSeen()).headers.authorization).toBe(`Bearer ${host.tokenFor(serverId)}`);

    expect(pageValues().length).toBeGreaterThan(2);
    for (const value of pageValues()) {
      expect(value).not.toMatch(TOKEN_ANYWHERE);
      expect(TOKEN_PATTERN.test(value)).toBe(false);
    }
  });

  it('drops page-supplied credentials and keeps the page headers it may send', async () => {
    host.setToken(serverId, `abc_${'T'.repeat(43)}`);
    await host.handle('request', {
      serverId,
      init: {
        method: 'POST',
        path: '/api/client/tasks/done',
        headers: {
          Authorization: 'Bearer abm_page',
          Cookie: 'board-session=abs_page',
          'X-Board-Sig': 'forged',
          'content-type': 'application/json',
        },
        body: '{"id":"x"}',
      },
    });
    const seen = await lastSeen();
    expect(seen.headers.authorization).toBe(`Bearer abc_${'T'.repeat(43)}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers['x-board-sig']).toBeUndefined();
    expect(seen.headers['x-board-contract']).toBe('1');
  });

  it('refuses a credential route, a dot segment and a foreign path, and records why', async () => {
    for (const refused of ['/api/pair', '/api/%2e%2e/x', '/other']) {
      await expect(
        host.handle('request', { serverId, init: { method: 'POST', path: refused } }),
      ).rejects.toThrow(/refuses/);
    }
    expect(host.refusals.map((entry) => entry.reason)).toEqual([
      'credential route',
      'dot segment',
      'outside /api/',
    ]);
  });

  it('adds and removes servers behind a confirmation', async () => {
    host.setConfirm((action) => action.action === 'add');
    const added = (await host.handle('servers.add', {
      name: 'b',
      address: 'http://127.0.0.1:1/',
    })) as {
      id: string;
      url: string;
    };
    expect(added.url).toBe('http://127.0.0.1:1');
    expect(await host.handle('servers.remove', { serverId: added.id })).toBe(false);
    expect(host.servers()).toHaveLength(2);
    host.setConfirm(() => true);
    expect(await host.handle('servers.remove', { serverId: added.id })).toBe(true);
    expect(host.servers()).toHaveLength(1);
    expect(host.confirmations.map((entry) => entry.action)).toEqual(['add', 'remove', 'remove']);
  });

  it('removing a server drops its token', async () => {
    host.setToken(serverId, `abc_${'T'.repeat(43)}`);
    await host.handle('servers.remove', { serverId });
    expect(host.tokenFor(serverId)).toBeUndefined();
  });

  it('records external-link opens', async () => {
    await host.handle('open-link', { url: 'http://127.0.0.1:9/approve?code=ABCD-2345' });
    expect(host.externalOpens).toEqual(['http://127.0.0.1:9/approve?code=ABCD-2345']);
  });

  it('signs out by deleting the token after logout', async () => {
    host.setToken(serverId, `abc_${'T'.repeat(43)}`);
    await host.handle('sign-out', { serverId });
    const seen = await lastSeen();
    expect(seen.url).toBe('/api/auth/logout');
    expect(seen.method).toBe('POST');
    expect(seen.headers.authorization).toBe(`Bearer abc_${'T'.repeat(43)}`);
    expect(seen.headers['content-type']).toBe('application/json');
    expect(host.tokenFor(serverId)).toBeUndefined();
  });

  it('pairs with a key it creates and keeps in Node', async () => {
    await host.handle('pair', { serverId, code: 'ABCD-2345', label: 'e2e' });
    expect(host.signerFor(serverId)?.publicKey).toBeTruthy();
    for (const value of pageValues()) {
      expect(value).not.toContain(host.signerFor(serverId)?.publicKey);
    }
  });
});

describe('page side', () => {
  interface Page {
    window: Record<string, unknown>;
    bridge: AgentBoardBridge;
    host: BridgeHost;
  }

  function mount(): Page {
    const host = createBridgeHost({ servers: [{ name: 'local', url: api.url }] });
    const window: Record<string, unknown> = {};
    window.__abBridge = (op: string, args: Record<string, unknown>) =>
      host.handle(op as never, args, (id, delivery) => {
        queueMicrotask(() =>
          (window.__abBridgeIn as (id: string, message: unknown) => void)(id, delivery),
        );
      });
    vm.runInNewContext(bridgeInitScript(), { window, ReadableStream, TextEncoder });
    return { window, bridge: window.agentBoardBridge as AgentBoardBridge, host };
  }

  it('installs a frozen bridge the page cannot replace', () => {
    const { window, bridge } = mount();
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(() => {
      'use strict';
      window.agentBoardBridge = {};
    }).toThrow();
  });

  it('lists servers and forwards a request as a streamed response', async () => {
    const { bridge } = mount();
    const [server] = await bridge.listServers();
    expect(server?.name).toBe('local');
    const response = await bridge.serverFetch(
      server?.id as string,
      'GET',
      '/api/client/me',
      {},
      null,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(await new Response(response.body).text())).toEqual({
      username: 'tester',
      keyId: null,
    });
  });

  it('hands an event stream to the page event by event and ends it', async () => {
    const { bridge } = mount();
    const [server] = await bridge.listServers();
    const response = await bridge.serverFetch(
      server?.id as string,
      'GET',
      '/api/machine/events',
      { accept: 'text/event-stream' },
      null,
    );
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(await new Response(response.body).text()).toBe(
      'event: tasks\ndata: {}\n\nevent: changed\ndata: {"n":2}\n\n',
    );
  });

  it('exposes exactly the members of the web bridge interface', () => {
    const { bridge } = mount();
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'addServer',
        'handoffFinish',
        'kind',
        'listServers',
        'notify',
        'openLink',
        'pair',
        'removeServer',
        'renameServer',
        'reportTab',
        'serverFetch',
        'signOut',
      ].sort(),
    );
  });

  it('records notifications and tab reports', async () => {
    const { bridge, host } = mount();
    const [server] = await bridge.listServers();
    await bridge.notify({ serverId: server?.id as string, taskId: 't1', title: 'Needs you' });
    await bridge.reportTab({ path: '/tasks/t1', title: 'Task' });
    expect(host.notifications).toEqual([
      { serverId: server?.id, taskId: 't1', title: 'Needs you' },
    ]);
    expect(host.reportedTabs).toEqual([{ path: '/tasks/t1', title: 'Task' }]);
  });

  it('never shows the page a token across the hand-off', async () => {
    const { bridge, host } = mount();
    const [server] = await bridge.listServers();
    const started = await bridge.serverFetch(
      server?.id as string,
      'POST',
      '/api/auth/handoff/start',
      { 'content-type': 'application/json' },
      JSON.stringify({ challenge: 'c'.repeat(43) }),
    );
    const flow = (JSON.parse(await new Response(started.body).text()) as { flow: string }).flow;
    await expect(
      bridge.handoffFinish(server?.id as string, flow, 'v'.repeat(43)),
    ).resolves.toBeUndefined();
    expect(host.tokenFor(server?.id as string)).toMatch(TOKEN_PATTERN);
    expect(host.passedToPage.join('\n')).not.toMatch(TOKEN_ANYWHERE);
    await expect(
      bridge.serverFetch(server?.id as string, 'POST', '/api/auth/handoff/finish', {}, null),
    ).rejects.toThrow(/refuses/);
  });
});
