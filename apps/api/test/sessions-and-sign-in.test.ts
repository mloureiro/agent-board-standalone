import { afterEach, describe, expect, it } from 'vitest';

import { tokenHash } from '@agent-board/sealing';

import type { CredentialStore } from '../src/auth/index.js';
import {
  CLIENT_TOKEN,
  CONTRACT_HEADERS,
  JSON_HEADERS,
  MACHINE_TOKEN,
  SESSION_TOKEN,
  boot,
  knownMachine,
  loginEnv,
  noLoginEnv,
  type TestBoard,
} from './helpers.js';

const boards: TestBoard[] = [];
const started = async (
  env: Parameters<typeof boot>[0],
  options?: Parameters<typeof boot>[1],
): Promise<TestBoard> => {
  const board = await boot(env, options);
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.app.close()));
});

const post = { method: 'POST', payload: '{}' } as const;

describe('authentication on every route', () => {
  it('[api-030] a client route without a user answers 401 in login mode', async () => {
    const { app } = await started(loginEnv());
    const answer = await app.inject({ url: '/api/client/me', headers: CONTRACT_HEADERS });
    expect(answer.statusCode).toBe(401);
    expect(answer.json().error.code).toBe('unauthorized');
  });

  it('[api-030] a machine route without a known token answers 401 before the body is read', async () => {
    const { app } = await started(noLoginEnv());
    const withoutToken = await app.inject({
      ...post,
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
    });
    expect(withoutToken.statusCode).toBe(401);
    const unknownToken = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: '{not json',
    });
    expect(unknownToken.statusCode).toBe(401);
    const cookieToken = await app.inject({
      ...post,
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(cookieToken.statusCode).toBe(401);
  });

  it('[api-030] the public routes answer without a user', async () => {
    const { app } = await started(loginEnv());
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/version' })).statusCode).toBe(200);
    const configRoute = await app.inject({ url: '/api/auth/config' });
    expect(configRoute.statusCode).not.toBe(401);
  });

  it('[api-030] no-login mode serves every client route as the configured user', async () => {
    const { app } = await started(noLoginEnv({ NO_LOGIN_USER: 'ada' }));
    const answer = await app.inject({ url: '/api/client/me', headers: CONTRACT_HEADERS });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ username: 'ada', keyId: null });
  });

  it('[api-030] a stored session reaches the route, an expired one and an unknown one do not', async () => {
    const hashes = {
      cookie: await tokenHash(SESSION_TOKEN),
      client: await tokenHash(CLIENT_TOKEN),
    };
    const credentials: CredentialStore = {
      findSession: async (hash, kind) => {
        if (kind === 'session' && hash === hashes.cookie) return { owner: 'grace', expired: false };
        if (kind === 'client' && hash === hashes.client) return { owner: 'grace', expired: true };
        return null;
      },
      findMachine: async () => null,
    };
    const { app } = await started(loginEnv(), { credentials });
    const cookie = await app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, cookie: `board-session=${SESSION_TOKEN}` },
    });
    expect(cookie.statusCode).toBe(200);
    expect(cookie.json().username).toBe('grace');

    const expired = await app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.message).toMatch(/expired/);

    const sessionInBearer = await app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, authorization: `Bearer ${SESSION_TOKEN}` },
    });
    expect(sessionInBearer.statusCode).toBe(401);
  });

  it('[api-030] a machine token reaches a machine route', async () => {
    const { app } = await started(noLoginEnv(), {
      credentials: knownMachine,
      handlers: [
        () => ({ 'machine.version': ({ principal }) => ({ owner: principal.owner }) as never }),
      ],
    });
    const answer = await app.inject({
      ...post,
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${MACHINE_TOKEN}` },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ owner: 'owner' });
  });
});

describe('origin and fetch-site checks', () => {
  const write = (headers: Record<string, string>) => ({
    method: 'POST' as const,
    url: '/api/auth/logout',
    headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, ...headers },
    payload: '{}',
  });

  it('[api-107] a write from a foreign origin gets 403 origin-refused', async () => {
    const { app } = await started(noLoginEnv());
    const answer = await app.inject(write({ origin: 'https://evil.example' }));
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error.code).toBe('origin-refused');
  });

  it('[api-107] a write from the server own origin passes, in no-login and login mode', async () => {
    const noLogin = await started(noLoginEnv());
    for (const origin of ['http://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
      const answer = await noLogin.app.inject(write({ origin }));
      expect(answer.statusCode, origin).toBe(200);
    }
    const other = await noLogin.app.inject(write({ origin: 'http://127.0.0.1:9999' }));
    expect(other.statusCode).toBe(403);

    const credentials: CredentialStore = {
      findSession: async () => ({ owner: 'grace', expired: false }),
      findMachine: async () => null,
    };
    const login = await started(loginEnv({ PUBLIC_URL: 'https://board.example.com' }), {
      credentials,
    });
    const own = await login.app.inject(
      write({
        origin: 'https://board.example.com',
        cookie: `__Host-board-session=${SESSION_TOKEN}`,
      }),
    );
    expect(own.statusCode).toBe(200);
    const foreign = await login.app.inject(write({ origin: 'https://evil.example' }));
    expect(foreign.statusCode).toBe(403);
  });

  it('[api-107] a write from an ALLOWED_ORIGINS origin passes even when the browser says cross-site', async () => {
    const { app } = await started(
      noLoginEnv({ ALLOWED_ORIGINS: 'https://app.example.com,tauri://localhost' }),
    );
    for (const origin of ['https://app.example.com', 'tauri://localhost']) {
      const answer = await app.inject(write({ origin, 'sec-fetch-site': 'cross-site' }));
      expect(answer.statusCode, origin).toBe(200);
    }
  });

  it('[api-107] Sec-Fetch-Site cross-site from an origin that is not allowed gets 403, even for own host names', async () => {
    const { app } = await started(noLoginEnv());
    const sameOriginName = await app.inject(
      write({ origin: 'http://localhost:4000', 'sec-fetch-site': 'cross-site' }),
    );
    expect(sameOriginName.statusCode).toBe(403);
    const sameSite = await app.inject(
      write({ origin: 'http://localhost:4000', 'sec-fetch-site': 'same-origin' }),
    );
    expect(sameSite.statusCode).toBe(200);
  });

  it('[api-107] a request without Origin (CLI, native bridge) passes, and reads are never refused', async () => {
    const { app } = await started(noLoginEnv());
    expect((await app.inject(write({}))).statusCode).toBe(200);
    const read = await app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, origin: 'https://evil.example' },
    });
    expect(read.statusCode).toBe(200);
  });
});
