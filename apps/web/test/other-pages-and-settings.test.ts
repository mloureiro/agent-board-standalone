import { CONTRACT_HEADER, CLIENT_HEADER } from '@rumo/contract';
import { describe, expect, it, vi } from 'vitest';

import {
  MissingFeatureError,
  UndeclaredRouteError,
  createServerClient,
  declaredRoute,
  type Transport,
} from '../src/transport/index.js';

const recording = (): {
  transport: Transport;
  seen: { path: string; headers: Record<string, string> }[];
} => {
  const seen: { path: string; headers: Record<string, string> }[] = [];
  return {
    seen,
    transport: {
      kind: 'same-origin',
      fetch: async (path, init) => {
        seen.push({ path, headers: { ...init?.headers } });
        return new Response('{}');
      },
    },
  };
};

describe('declared routes', () => {
  it('[web-077] a route the contract declares for clients and the public passes', async () => {
    const { transport, seen } = recording();
    const client = createServerClient(transport, { features: [] });
    await client.request('/api/client/events');
    await client.request('/api/version');
    expect(seen.map((call) => call.path)).toEqual(['/api/client/events', '/api/version']);
  });

  it('[web-077] a path the contract does not declare is refused before any request', async () => {
    const { transport, seen } = recording();
    const client = createServerClient(transport, { features: [] });
    await expect(client.request('/api/client/not-a-route')).rejects.toBeInstanceOf(
      UndeclaredRouteError,
    );
    await expect(client.request('/somewhere/else')).rejects.toBeInstanceOf(UndeclaredRouteError);
    expect(seen).toEqual([]);
  });

  it('[web-077] machine routes and the wrong method are not routes the browser client calls', async () => {
    const { transport } = recording();
    const client = createServerClient(transport, { features: [] });
    await expect(client.request('/api/machine/version', { method: 'POST' })).rejects.toBeInstanceOf(
      UndeclaredRouteError,
    );
    await expect(client.request('/api/client/events', { method: 'POST' })).rejects.toBeInstanceOf(
      UndeclaredRouteError,
    );
    expect(declaredRoute('GET', '/api/client/events?project=abc')?.name).toBe('client.events');
  });

  it('[web-077] a route whose feature the server did not announce is refused', async () => {
    const { transport, seen } = recording();
    const featured = declaredRoute('POST', '/api/pair');
    expect(featured?.feature).toBe('pairing');
    const without = createServerClient(transport, { features: [] });
    await expect(
      without.request('/api/pair', { method: 'POST', body: '{}' }),
    ).rejects.toBeInstanceOf(MissingFeatureError);
    const withFeature = createServerClient(transport, { features: ['pairing'] });
    await withFeature.request('/api/pair', { method: 'POST', body: '{}' });
    expect(seen).toHaveLength(1);
  });

  it('[web-077] client routes carry the contract level and client version; public routes carry neither', async () => {
    const { transport, seen } = recording();
    const client = createServerClient(transport, { features: [] });
    await client.request('/api/client/events');
    await client.request('/api/version');
    expect(seen[0]?.headers[CONTRACT_HEADER]).toBe('1');
    expect(seen[0]?.headers[CLIENT_HEADER]).toMatch(/^web\/\d+\.\d+\.\d+$/);
    expect(seen[1]?.headers[CONTRACT_HEADER]).toBeUndefined();
    expect(seen[1]?.headers[CLIENT_HEADER]).toBeUndefined();
  });

  it('[web-077] the transport is called once per request', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const client = createServerClient({ kind: 'native', fetch: fetchSpy }, { features: [] });
    await client.request('/api/client/events');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
