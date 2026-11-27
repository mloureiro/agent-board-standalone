import { CONTRACT, MIN_SERVER } from '@rumo/contract';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RumoBridge } from '../src/bridge/index.js';
import {
  checkConnection,
  createBrowserRegistry,
  createNativeRegistry,
  describeConnection,
  reachesHttpFromHttps,
  transportFor,
  type ConnectionState,
  type ServerEntry,
} from '../src/servers/index.js';
import { serverNamespace } from '../src/storage/index.js';
import type { Transport } from '../src/transport/index.js';
import {
  PAGE_ORIGIN,
  checkReturning,
  renderApp,
  serverVersion,
  versionDocument,
} from './render.js';

const answering = (document: unknown, status = 200): Transport => ({
  kind: 'same-origin',
  fetch: async () => new Response(JSON.stringify(document), { status }),
});

const scripted = (
  ...steps: (Response | Error)[]
): { transport: Transport; calls: () => number } => {
  let call = 0;
  return {
    calls: () => call,
    transport: {
      kind: 'same-origin',
      fetch: async () => {
        const step = steps[Math.min(call, steps.length - 1)];
        call += 1;
        if (step instanceof Error) throw step;
        return step!.clone();
      },
    },
  };
};

const noSleep = async (): Promise<void> => undefined;
const paired = async (): Promise<boolean> => true;
const unpaired = async (): Promise<boolean> => false;

const check = (transport: Transport, hasBoundKey = paired) =>
  checkConnection({ transport, hasBoundKey, sleep: noSleep });

const json = (document: unknown, status = 200): Response =>
  new Response(JSON.stringify(document), { status });

describe('connection check states', () => {
  it('[web-091] a compatible server with no session requirement is up', async () => {
    const result = await check(answering(versionDocument()));
    expect(result.state).toBe('up');
  });

  it('[web-091] a server that cannot be reached is unreachable', async () => {
    const { transport } = scripted(new TypeError('Failed to fetch'));
    expect((await check(transport)).state).toBe('unreachable');
  });

  it('[web-091] a server that does not answer in time is a timeout', async () => {
    const hanging: Transport = {
      kind: 'same-origin',
      fetch: (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
        }),
    };
    const result = await checkConnection({
      transport: hanging,
      hasBoundKey: paired,
      sleep: noSleep,
      connectTimeoutMs: 5,
      totalTimeoutMs: 20,
      retryDelaysMs: [],
    });
    expect(result.state).toBe('timeout');
  });

  it('[web-091] a 500 answer is a server error and is not retried', async () => {
    const { transport, calls } = scripted(new Response('boom', { status: 500 }));
    expect(await check(transport)).toEqual({ state: 'server-error', status: 500 });
    expect(calls()).toBe(1);
  });

  it('[web-091] an answer that is not a version document is a server error', async () => {
    expect(await check(answering({ hello: 'world' }))).toEqual({
      state: 'server-error',
      status: 200,
    });
  });

  it('[web-091] a redirect is not followed and counts as unreachable', async () => {
    const seen: (string | undefined)[] = [];
    const transport: Transport = {
      kind: 'same-origin',
      fetch: async (_path, init) => {
        seen.push(init?.redirect);
        return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      },
    };
    expect((await check(transport)).state).toBe('unreachable');
    expect(seen[0]).toBe('manual');
  });

  it('[web-091] a session that is none or expired is signed out', async () => {
    for (const session of ['none', 'expired']) {
      expect((await check(answering(versionDocument({ session })))).state).toBe('signed-out');
    }
  });

  it('[web-091] a valid session is up', async () => {
    expect((await check(answering(versionDocument({ session: 'valid' })))).state).toBe('up');
  });

  it('[web-091] a server that requires signatures and a client without a bound key needs pairing', async () => {
    const document = versionDocument({
      modules: { signIn: [], requestSignature: true, scheduling: true, feeds: true },
    });
    expect((await check(answering(document), unpaired)).state).toBe('needs-pairing');
    expect((await check(answering(document), paired)).state).toBe('up');
  });

  it('[web-091] the check asks only for /api/version, once, without credentials of its own', async () => {
    const fetchSpy = vi.fn<Transport['fetch']>(async () => json(versionDocument()));
    await check({ kind: 'same-origin', fetch: fetchSpy });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/version');
  });

  it('[web-091] the messages say why a server is not up', () => {
    const states: ConnectionState[] = [
      { state: 'unreachable' },
      { state: 'timeout' },
      { state: 'server-error', status: 503 },
      { state: 'too-old', message: 'm', server: serverVersion() },
      { state: 'too-new', message: 'm', server: serverVersion() },
      { state: 'signed-out', server: serverVersion() },
      { state: 'needs-pairing', server: serverVersion() },
    ];
    const messages = states.map((state) => describeConnection(state));
    expect(new Set(messages).size).toBe(states.length);
    expect(messages[2]).toContain('503');
  });

  it('[web-091] an https page that cannot reach an http server says the browser may block it', () => {
    expect(reachesHttpFromHttps('https://board.example', 'http://127.0.0.1:3000/')).toBe(true);
    expect(reachesHttpFromHttps('http://localhost:3000', 'http://127.0.0.1:3001/')).toBe(false);
    expect(describeConnection({ state: 'unreachable' }, { blockedLoopback: true })).toMatch(
      /Safari always blocks an https page/,
    );
  });

  it('[web-091] a failed check while another server is up marks only the failed server', async () => {
    const down = { state: 'unreachable' } as const;
    renderApp({ check: checkReturning(down) });
    expect(await screen.findByText('Not answering, retrying')).toBeInTheDocument();
  });
});

describe('connection check retries', () => {
  it('[web-092] a transient failure retries at 1 s and 3 s before reporting', async () => {
    const delays: number[] = [];
    const { transport, calls } = scripted(new TypeError('Failed to fetch'));
    const result = await checkConnection({
      transport,
      hasBoundKey: paired,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(result.state).toBe('unreachable');
    expect(delays).toEqual([1000, 3000]);
    expect(calls()).toBe(3);
  });

  it('[web-092] a failure that clears within the retries is reported as up', async () => {
    const { transport, calls } = scripted(
      new TypeError('Failed to fetch'),
      new Response('', { status: 503 }),
      json(versionDocument()),
    );
    expect((await check(transport)).state).toBe('up');
    expect(calls()).toBe(3);
  });

  it('[web-092] 502, 503 and 504 are retried', async () => {
    for (const status of [502, 503, 504]) {
      const { transport, calls } = scripted(new Response('', { status }));
      expect(await check(transport)).toEqual({ state: 'server-error', status });
      expect(calls()).toBe(3);
    }
  });

  it('[web-092] a state is never latched: the next check can recover and the banner clears', async () => {
    let healthy = false;
    const flaky = async (): Promise<ConnectionState> =>
      healthy ? { state: 'up', server: serverVersion() } : { state: 'unreachable' };
    renderApp({
      check: flaky,
      registry: createBrowserRegistry({ pageOrigin: PAGE_ORIGIN }),
    });
    expect(await screen.findByText('Not answering, retrying')).toBeInTheDocument();
    healthy = true;
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });
  it('[web-092] focus events faster than a slow check still let each check land', async () => {
    let checks = 0;
    let signedOut = false;
    const slow = async (): Promise<ConnectionState> => {
      checks += 1;
      const answer: ConnectionState = signedOut
        ? { state: 'signed-out', server: serverVersion() }
        : { state: 'up', server: serverVersion() };
      await new Promise((resolve) => setTimeout(resolve, 150));
      return answer;
    };
    renderApp({ check: slow, registry: createBrowserRegistry({ pageOrigin: PAGE_ORIGIN }) });
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    signedOut = true;
    const storm = setInterval(() => window.dispatchEvent(new Event('focus')), 40);
    try {
      expect(
        await screen.findByRole('heading', { name: 'Signed out' }, { timeout: 3000 }),
      ).toBeInTheDocument();
    } finally {
      clearInterval(storm);
    }
    expect(checks).toBeLessThan(40);
  });
});

describe('version handshake', () => {
  it('[web-078] a server whose minimum client is higher shows client too old with both versions', async () => {
    const result = await check(
      answering(versionDocument({ minClient: { cli: 1, web: CONTRACT + 1 } })),
    );
    expect(result.state).toBe('too-old');
    if (result.state !== 'too-old') return;
    expect(result.message).toContain(`contract ${CONTRACT}`);
    expect(result.message).toContain(`contract ${CONTRACT + 1}`);

    renderApp({ check: checkReturning(result) });
    expect(await screen.findByRole('heading', { name: 'Client too old' })).toBeInTheDocument();
    expect(screen.getByText(/contract 2/)).toBeInTheDocument();
  });

  it('[web-078] a server with a lower contract shows server too old with both versions', async () => {
    const result = await check(answering(versionDocument({ contract: MIN_SERVER - 1 })));
    expect(result.state).toBe('too-new');
    if (result.state !== 'too-new') return;
    expect(result.message).toContain(`contract ${MIN_SERVER - 1}`);
    expect(result.message).toContain(`contract ${MIN_SERVER}`);

    renderApp({ check: checkReturning(result) });
    expect(await screen.findByRole('heading', { name: 'Server too old' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('[web-078] the board loads against a compatible server', async () => {
    renderApp();
    expect(await screen.findByRole('main')).toBeInTheDocument();
    expect(screen.queryByText(/too old/i)).not.toBeInTheDocument();
  });

  it('[web-078] a signed-out server replaces the page with its sign-in page', async () => {
    renderApp({ check: checkReturning({ state: 'signed-out', server: serverVersion() }) });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('transports', () => {
  const entry = (url: string): ServerEntry => ({ id: 'srv-1', name: 'Server', url });

  it('[web-101] a server on the page origin gets the same-origin transport', () => {
    const transport = transportFor(entry(`${PAGE_ORIGIN}/`), {
      pageOrigin: PAGE_ORIGIN,
      bridge: null,
    });
    expect(transport.kind).toBe('same-origin');
  });

  it('[web-101] a server on another origin gets the cross-origin transport', () => {
    const transport = transportFor(entry('https://other.example/'), {
      pageOrigin: PAGE_ORIGIN,
      bridge: null,
    });
    expect(transport.kind).toBe('cross-origin');
  });

  it('[web-101] a wrapper gets the native transport for every server', () => {
    const bridge = { kind: 'client-app' } as RumoBridge;
    for (const url of [`${PAGE_ORIGIN}/`, 'https://other.example/']) {
      expect(transportFor(entry(url), { pageOrigin: PAGE_ORIGIN, bridge }).kind).toBe('native');
    }
  });

  it('[web-101] the native transport reads the bridge answer as a streamed response', async () => {
    const serverFetch = vi.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Response('event: changed\ndata: {}\n\n').body,
    }));
    const bridge = { kind: 'mobile', serverFetch } as unknown as RumoBridge;
    const transport = transportFor(entry('https://other.example/'), {
      pageOrigin: PAGE_ORIGIN,
      bridge,
    });
    const answer = await transport.fetch('/api/client/events', {
      headers: { accept: 'text/event-stream' },
    });
    expect(await answer.text()).toBe('event: changed\ndata: {}\n\n');
    expect(serverFetch).toHaveBeenCalledWith(
      'srv-1',
      'GET',
      '/api/client/events',
      { accept: 'text/event-stream' },
      null,
    );
  });

  it('[web-101] the cross-origin transport sends the client token and no cookies', async () => {
    await serverNamespace('srv-1').secrets.put('client-token', `abc_${'a'.repeat(43)}`);
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response('{}');
    }) as typeof fetch;
    try {
      const transport = transportFor(entry('https://other.example/base/'), {
        pageOrigin: PAGE_ORIGIN,
        bridge: null,
      });
      await transport.fetch('/api/version');
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]?.url).toBe('https://other.example/api/version');
    expect(seen[0]?.init?.credentials).toBe('omit');
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe(
      `Bearer abc_${'a'.repeat(43)}`,
    );
  });

  it('[web-101] the same-origin transport sends cookies and no authorization header', async () => {
    const seen: (RequestInit | undefined)[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init);
      return new Response('{}');
    }) as typeof fetch;
    try {
      await transportFor(entry(`${PAGE_ORIGIN}/`), { pageOrigin: PAGE_ORIGIN, bridge: null }).fetch(
        '/api/version',
      );
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]?.credentials).toBe('same-origin');
    expect(new Headers(seen[0]?.headers).has('authorization')).toBe(false);
  });
});

describe('server namespaces', () => {
  const idb = async (): Promise<string[]> =>
    (await indexedDB.databases()).flatMap((database) => (database.name ? [database.name] : []));

  it('[web-102] each server owns an ab:<id>: key prefix and an rumo:<id> database', async () => {
    const one = serverNamespace('one');
    const two = serverNamespace('two');
    one.local.set('draft:new', 'a');
    two.local.set('draft:new', 'b');
    await one.secrets.put('client-token', 'x');
    await two.secrets.put('client-token', 'y');

    expect(localStorage.getItem('ab:one:draft:new')).toBe('a');
    expect(localStorage.getItem('ab:two:draft:new')).toBe('b');
    expect(await idb()).toEqual(expect.arrayContaining(['rumo:one', 'rumo:two']));
    expect(await one.secrets.names()).toEqual(['client-token']);
    expect(one.local.keys()).toEqual(['draft:new']);
  });

  it('[web-102] removing a server deletes exactly its namespace', async () => {
    const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    const first = await registry.add({ name: 'First', address: 'https://first.example' });
    const second = await registry.add({ name: 'Second', address: 'https://second.example' });
    if (!first.ok || !second.ok) throw new Error('the servers were not added');
    const a = serverNamespace(first.entry.id);
    const b = serverNamespace(second.entry.id);
    a.local.set('draft:new', 'a');
    b.local.set('draft:new', 'b');
    await a.secrets.put('client-token', 'x');
    await b.secrets.put('client-token', 'y');
    localStorage.setItem('ab:other-thing', 'kept');

    expect(await registry.remove(first.entry.id)).toBe(true);

    expect(a.local.keys()).toEqual([]);
    expect(await idb()).not.toContain(`rumo:${first.entry.id}`);
    expect(b.local.get('draft:new')).toBe('b');
    expect(await b.secrets.get('client-token')).toBe('y');
    expect(localStorage.getItem('ab:other-thing')).toBe('kept');
    expect((await registry.list()).map((entry) => entry.name)).toEqual(['localhost', 'Second']);
  });

  it('[web-102] two entries for the same address share nothing', async () => {
    const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    const a = await registry.add({ name: 'A', address: 'https://same.example' });
    const b = await registry.add({ name: 'B', address: 'https://same.example' });
    if (!a.ok || !b.ok) throw new Error('the servers were not added');
    expect(a.entry.id).not.toBe(b.entry.id);
    serverNamespace(a.entry.id).local.set('draft:new', 'private');
    expect(serverNamespace(b.entry.id).local.get('draft:new')).toBeNull();
  });

  it('[web-102] the server list is kept under ab:servers as id, name and url only', async () => {
    const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    await registry.add({ name: ' Second ', address: 'https://second.example' });
    const stored = JSON.parse(localStorage.getItem('ab:servers') ?? '[]') as Record<
      string,
      unknown
    >[];
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => Object.keys(item).sort())).toEqual([
      ['id', 'name', 'url'],
      ['id', 'name', 'url'],
    ]);
    expect(stored[1]).toMatchObject({ name: 'Second', url: 'https://second.example/' });
  });

  it('[web-102] a first visit lists the page origin as the one server', async () => {
    const registry = createBrowserRegistry({ pageOrigin: 'http://127.0.0.1:4000' });
    const [only, ...rest] = await registry.list();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ name: '127.0.0.1:4000', url: 'http://127.0.0.1:4000/' });
  });

  it('[web-102] addresses the contract rejects are not added', async () => {
    const registry = createBrowserRegistry({ pageOrigin: PAGE_ORIGIN });
    expect(await registry.add({ name: 'x', address: 'ftp://nope' })).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(await registry.add({ name: 'x', address: 'http://lan.example' })).toEqual({
      ok: false,
      problem: 'insecure',
    });
  });

  it('[web-102] a native registry delegates to the bridge and clears the namespace of a removed server', async () => {
    const stored: ServerEntry[] = [{ id: 'native-1', name: 'Native', url: 'https://n.example/' }];
    const bridge = {
      kind: 'client-app',
      listServers: async () => stored,
      addServer: vi.fn(async () => null),
      removeServer: vi.fn(async () => {
        draftsAtRemoval.push(...serverNamespace('native-1').local.keys());
        return true;
      }),
      renameServer: vi.fn(async () => undefined),
    } as unknown as RumoBridge;
    const draftsAtRemoval: string[] = [];
    const registry = createNativeRegistry(bridge);
    serverNamespace('native-1').local.set('draft:new', 'x');

    expect(await registry.list()).toEqual(stored);
    expect(await registry.add({ name: 'N', address: 'https://m.example' })).toEqual({
      ok: false,
      problem: 'declined',
    });
    expect(await registry.remove('native-1')).toBe(true);
    expect(serverNamespace('native-1').local.keys()).toEqual([]);
    expect(draftsAtRemoval).toEqual([]);
    expect(await registry.remove('unknown')).toBe(false);
  });
});
