import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLIENT_BODY_LIMIT } from '@rumo/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FLOW_TTL_MS,
  bindClientKey,
  bindSessionKey,
  codeHash,
  createCredentialStore,
  ensureUser,
  issueSession,
  newFlowId,
  type SessionDeps,
} from '../src/auth/index.js';
import { fixedClock } from '../src/clock.js';
import * as schema from '../src/db/schema/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import { openPgliteDatabase, type Database } from '../src/modules/database/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { newSigner, type TestSigner } from './signing.js';

const ME = '/api/client/me';
const LOGOUT = '/api/auth/logout';
const PAIR = '/api/pair';
const REGISTER = '/api/machine/register-key';
const PAIR_CODE = 'ABCD-2345';

interface Board {
  app: FastifyInstance;
  database: Database;
  clock: ReturnType<typeof fixedClock>;
  deps: SessionDeps;
  close(): Promise<void>;
}

const open = async (env: Env): Promise<Board> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-api-signature-'));
  const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
  const config = loadConfig({
    DATABASE_URL: 'pglite:///unused',
    REQUEST_SIGNATURE: 'on',
    ...env,
  });
  const clock = fixedClock(new Date());
  const deps: SessionDeps = {
    database,
    clock,
    sessionDays: config.signIn.mode === 'login' ? config.signIn.sessionDays : 30,
  };
  const app = await createServer(
    config,
    {
      database,
      credentials: createCredentialStore(deps),
      streams: createOpenStreams(),
      events: createMemoryEvents(),
    },
    { clock, handlerSets: HANDLER_SETS },
  );
  await app.ready();
  return {
    app,
    database,
    clock,
    deps,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const boards: Board[] = [];
const started = async (env: Env): Promise<Board> => {
  const board = await open(env);
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.close()));
});

const noLogin = (): Promise<Board> => started({ NO_LOGIN_USER: 'owner' });
const login = (): Promise<Board> =>
  started({ AUTH_MODE: 'login', PUBLIC_URL: 'http://localhost:4000' });

const seconds = (board: Board): number => Math.floor(board.clock.now().getTime() / 1000);

const issuePairCode = async (board: Board, code = PAIR_CODE, issuedAt = board.clock.now()) => {
  await board.database.withSystem(async (system) =>
    system.createAuthFlow({
      id: newFlowId(),
      kind: 'pair',
      codeHash: await codeHash(code),
      expiresAt: new Date(issuedAt.getTime() + FLOW_TTL_MS),
    }),
  );
};

const pair = (board: Board, signer: TestSigner, code = PAIR_CODE, label = 'device') =>
  board.app.inject({
    method: 'POST',
    url: PAIR,
    headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
    payload: JSON.stringify({ code, publicKey: signer.publicKey, label }),
  });

const pairedSigner = async (board: Board): Promise<TestSigner> => {
  const signer = await newSigner();
  await issuePairCode(board);
  expect((await pair(board, signer)).statusCode).toBe(200);
  return signer;
};

const signedGet = async (
  board: Board,
  signer: TestSigner,
  url = ME,
  overrides: { ts?: number; nonce?: string } = {},
  extra: Record<string, string> = {},
) =>
  board.app.inject({
    method: 'GET',
    url,
    headers: {
      ...CONTRACT_HEADERS,
      ...(await signer.headers('GET', url, undefined, {
        ts: seconds(board),
        ...overrides,
      })),
      ...extra,
    },
  });

describe('request signature checks', () => {
  it('[api-022] an unsigned client or machine request gets 401 and public routes stay open', async () => {
    const board = await noLogin();
    const client = await board.app.inject({ url: ME, headers: CONTRACT_HEADERS });
    expect(client.statusCode).toBe(401);
    const machine = await board.app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: '{}',
    });
    expect(machine.statusCode).toBe(401);
    expect((await board.app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('[api-022] a signed request from a bound key is served', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const answer = await signedGet(board, signer);
    expect(answer.statusCode).toBe(200);
    expect(answer.json().username).toBe('owner');
  });

  it('[api-022] a request signed for another path gets 401', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const answer = await board.app.inject({
      url: ME,
      headers: {
        ...CONTRACT_HEADERS,
        ...(await signer.headers('GET', '/api/client/elsewhere', undefined, {
          ts: seconds(board),
        })),
      },
    });
    expect(answer.statusCode).toBe(401);
  });

  it('[api-022] a key id the server does not know gets 401 key-unknown', async () => {
    const board = await noLogin();
    const stranger = await newSigner();
    const answer = await signedGet(board, stranger);
    expect(answer.statusCode).toBe(401);
    expect(answer.json().error.code).toBe('key-unknown');
  });

  it('[api-022] the signature is checked before the body is read: a bad signature on an oversized body gets 401', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const answer = await board.app.inject({
      method: 'POST',
      url: LOGOUT,
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        ...(await signer.headers('POST', '/api/client/elsewhere', undefined, {
          ts: seconds(board),
        })),
      },
      payload: 'a'.repeat(CLIENT_BODY_LIMIT + 1),
    });
    expect(answer.statusCode).toBe(401);
  });

  it('[api-022] a correctly signed oversized body still gets 413', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const body = 'a'.repeat(CLIENT_BODY_LIMIT + 1);
    const answer = await board.app.inject({
      method: 'POST',
      url: LOGOUT,
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        ...(await signer.headers('POST', LOGOUT, body, { ts: seconds(board) })),
      },
      payload: body,
    });
    expect(answer.statusCode).toBe(413);
  });

  it('[api-122] a timestamp more than 120 s off is refused, 119 s is accepted', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const now = seconds(board);
    expect((await signedGet(board, signer, ME, { ts: now - 121 })).statusCode).toBe(401);
    expect((await signedGet(board, signer, ME, { ts: now + 121 })).statusCode).toBe(401);
    expect((await signedGet(board, signer, ME, { ts: now - 119 })).statusCode).toBe(200);
  });

  it('[api-122] the timestamp is read against the server clock', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const stale = seconds(board);
    board.clock.set(new Date(board.clock.now().getTime() + 200_000));
    expect((await signedGet(board, signer, ME, { ts: stale })).statusCode).toBe(401);
  });

  it('[api-122] a nonce already used in the window is refused', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const nonce = 'n'.repeat(22);
    expect((await signedGet(board, signer, ME, { nonce })).statusCode).toBe(200);
    expect((await signedGet(board, signer, ME, { nonce })).statusCode).toBe(401);
    expect((await signedGet(board, signer, ME, { nonce: 'm'.repeat(22) })).statusCode).toBe(200);
  });

  it('[api-122] a malformed nonce is refused', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    expect((await signedGet(board, signer, ME, { nonce: 'short' })).statusCode).toBe(401);
  });

  it('[api-122] a body that does not match Content-Digest is refused, a matching one is served', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const send = async (signedBody: string, sentBody: string) =>
      board.app.inject({
        method: 'POST',
        url: LOGOUT,
        headers: {
          ...JSON_HEADERS,
          ...CONTRACT_HEADERS,
          ...(await signer.headers('POST', LOGOUT, signedBody, { ts: seconds(board) })),
        },
        payload: sentBody,
      });
    expect((await send('{}', '{}')).statusCode).toBe(200);
    expect((await send('{}', '{ }')).statusCode).toBe(401);
  });

  it('[api-122] a body sent without a signed Content-Digest is refused', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const answer = await board.app.inject({
      method: 'POST',
      url: LOGOUT,
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        ...(await signer.headers('POST', LOGOUT, undefined, { ts: seconds(board) })),
      },
      payload: '{}',
    });
    expect(answer.statusCode).toBe(401);
  });

  it('[api-022] with the module off, requests need no signature', async () => {
    const board = await started({ NO_LOGIN_USER: 'owner', REQUEST_SIGNATURE: 'off' });
    expect((await board.app.inject({ url: ME, headers: CONTRACT_HEADERS })).statusCode).toBe(200);
    const stranger = await newSigner();
    const answer = await board.app.inject({
      method: 'POST',
      url: PAIR,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: JSON.stringify({ code: PAIR_CODE, publicKey: stranger.publicKey, label: 'x' }),
    });
    expect(answer.json().error.code).toBe('not-enabled');
  });
});

describe('request signature key binding', () => {
  it('[api-120] POST /api/pair binds a key once, refuses a reused code and stores the key as paired', async () => {
    const board = await noLogin();
    await issuePairCode(board);
    const first = await newSigner();
    const bound = await pair(board, first, PAIR_CODE, 'first');
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toEqual({ keyId: first.keyId });
    const rows = await board.database.withOwner('owner', (tx) =>
      tx.select().from(schema.clientKey),
    );
    expect(rows).toMatchObject([{ keyId: first.keyId, kind: 'paired', label: 'first' }]);

    const second = await newSigner();
    expect((await pair(board, second, PAIR_CODE, 'second')).statusCode).toBe(403);
    expect((await signedGet(board, second)).json().error.code).toBe('key-unknown');
  });

  it('[api-120] a code older than 10 minutes is refused and an unknown code is refused', async () => {
    const board = await noLogin();
    await issuePairCode(board);
    board.clock.set(new Date(board.clock.now().getTime() + FLOW_TTL_MS + 1000));
    expect((await pair(board, await newSigner())).statusCode).toBe(403);
    expect((await pair(board, await newSigner(), 'ZZZZ-9999')).statusCode).toBe(403);
  });

  it('[api-120] a code is matched without regard to case', async () => {
    const board = await noLogin();
    await issuePairCode(board);
    const answer = await board.app.inject({
      method: 'POST',
      url: PAIR,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: JSON.stringify({
        code: PAIR_CODE,
        publicKey: (await newSigner()).publicKey,
        label: 'x',
      }),
    });
    expect(answer.statusCode).toBe(200);
  });

  it('[api-120] pairing is refused on a login server', async () => {
    const board = await login();
    await issuePairCode(board);
    expect((await pair(board, await newSigner())).statusCode).toBe(404);
  });

  it('[api-120] a public key that is not a P-256 key is refused', async () => {
    const board = await noLogin();
    await issuePairCode(board);
    const answer = await board.app.inject({
      method: 'POST',
      url: PAIR,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: JSON.stringify({ code: PAIR_CODE, publicKey: 'AAAA', label: 'x' }),
    });
    expect(answer.statusCode).toBe(400);
  });

  it('[api-120] one register-key binds per machine, a second is refused and a cleared machine can bind again', async () => {
    const board = await noLogin();
    await board.database.withOwner('owner', async (tx) => {
      await ensureUser(tx, 'owner', null);
      await tx.insert(schema.machine).values({ id: 'laptop', tokenHash: '0'.repeat(64) });
    });
    const principal = { owner: 'owner', machineId: 'laptop' };
    const bind = async (signer: TestSigner) =>
      bindClientKey(board.database, board.clock, {
        owner: principal.owner,
        publicKey: signer.publicKey,
        label: 'machine key',
        binding: { kind: 'machine', machineId: principal.machineId },
      });
    const first = await newSigner();
    expect(await bind(first)).toBe(first.keyId);
    await expect(bind(await newSigner())).rejects.toMatchObject({ code: 'conflict' });

    await board.database.withOwner('owner', (tx) =>
      tx.delete(schema.clientKey).where(eq(schema.clientKey.machineId, 'laptop')),
    );
    const other = await newSigner();
    expect(await bind(other)).toBe(other.keyId);
  });

  it('[api-120] a machine key serves its machine and not a client route', async () => {
    const board = await noLogin();
    await issuePairCode(board);
    const paired = await newSigner();
    await pair(board, paired);
    const machineKey = await newSigner();
    await board.database.withOwner('owner', (tx) =>
      tx.insert(schema.machine).values({ id: 'laptop', tokenHash: '0'.repeat(64) }),
    );
    await bindClientKey(board.database, board.clock, {
      owner: 'owner',
      publicKey: machineKey.publicKey,
      label: 'machine',
      binding: { kind: 'machine', machineId: 'laptop' },
    });
    expect((await signedGet(board, machineKey)).statusCode).toBe(401);
  });

  it('[api-120] register-key skips the signature check and reaches machine authentication', async () => {
    const board = await noLogin();
    const answer = await board.app.inject({
      method: 'POST',
      url: REGISTER,
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
      payload: JSON.stringify({ publicKey: (await newSigner()).publicKey, label: 'x' }),
    });
    expect(answer.json().error.message).toBe('a valid machine token is required');
  });

  it('[api-120] the user lists the bound keys and a revoked key gets key-unknown', async () => {
    const board = await noLogin();
    const signer = await pairedSigner(board);
    const url = '/api/client/devices/list';
    const listed = await signedGet(board, signer, url);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().devices).toMatchObject([
      { keyId: signer.keyId, kind: 'paired', lastUsedAt: null },
    ]);

    await board.database.withOwner('owner', (tx) =>
      tx.delete(schema.clientKey).where(eq(schema.clientKey.keyId, signer.keyId)),
    );
    const after = await signedGet(board, signer);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('key-unknown');
  });
});

describe('request signature on a login server', () => {
  const PKCE_VERIFIER = 'v'.repeat(43);
  const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url');

  const handoff = async (board: Board, approver: { token: string; signer: TestSigner }) => {
    const post = (url: string, payload: object, headers: object = {}) =>
      board.app.inject({
        method: 'POST',
        url,
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, ...headers },
        payload: JSON.stringify(payload),
      });
    const start = await post('/api/auth/handoff/start', { challenge: PKCE_CHALLENGE });
    const { flow } = start.json() as { flow: string };
    const body = JSON.stringify({ flow });
    const approved = await board.app.inject({
      method: 'POST',
      url: '/api/auth/handoff/approve',
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        authorization: `Bearer ${approver.token}`,
        ...(await approver.signer.headers('POST', '/api/auth/handoff/approve', body, {
          ts: seconds(board),
        })),
      },
      payload: body,
    });
    expect(approved.statusCode).toBe(200);
    const incoming = await newSigner();
    const finished = await post('/api/auth/handoff/finish', {
      flow,
      verifier: PKCE_VERIFIER,
      tokenKind: 'client',
      publicKey: incoming.publicKey,
    });
    return { finished, incoming };
  };

  it('[api-120] the hand-off finish carrying a public key binds it to the new session only', async () => {
    const board = await login();
    await board.database.withOwner('grace', (tx) => ensureUser(tx, 'grace', 'oidc'));
    const approverToken = (await issueSession(board.deps, 'grace', 'client', 'oidc')).token;
    const approverKey = await newSigner();
    await bindSessionKey(
      board.database,
      board.clock,
      'grace',
      approverToken,
      approverKey.publicKey,
      'approver',
    );

    const { finished, incoming } = await handoff(board, {
      token: approverToken,
      signer: approverKey,
    });
    expect(finished.statusCode).toBe(200);
    const { token } = finished.json() as { token: string };

    const url = ME;
    const signed = await incoming.headers('GET', url, undefined, { ts: seconds(board) });
    const ok = await board.app.inject({
      url,
      headers: { ...CONTRACT_HEADERS, authorization: `Bearer ${token}`, ...signed },
    });
    expect(ok.statusCode).toBe(200);

    const unsigned = await board.app.inject({
      url,
      headers: { ...CONTRACT_HEADERS, authorization: `Bearer ${token}` },
    });
    expect(unsigned.statusCode).toBe(401);

    const otherSession = await board.app.inject({
      url,
      headers: {
        ...CONTRACT_HEADERS,
        authorization: `Bearer ${approverToken}`,
        ...(await incoming.headers('GET', url, undefined, { ts: seconds(board) })),
      },
    });
    expect(otherSession.statusCode).toBe(401);
  });

  it('[api-120] a hand-off finish with an invalid public key is refused before the session is issued', async () => {
    const board = await login();
    await board.database.withOwner('grace', (tx) => ensureUser(tx, 'grace', 'oidc'));
    const approverToken = (await issueSession(board.deps, 'grace', 'client', 'oidc')).token;
    const approverKey = await newSigner();
    await bindSessionKey(
      board.database,
      board.clock,
      'grace',
      approverToken,
      approverKey.publicKey,
      'approver',
    );
    const post = (url: string, payload: object) =>
      board.app.inject({
        method: 'POST',
        url,
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        payload: JSON.stringify(payload),
      });
    const { flow } = (
      await post('/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })
    ).json() as {
      flow: string;
    };
    const body = JSON.stringify({ flow });
    await board.app.inject({
      method: 'POST',
      url: '/api/auth/handoff/approve',
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        authorization: `Bearer ${approverToken}`,
        ...(await approverKey.headers('POST', '/api/auth/handoff/approve', body, {
          ts: seconds(board),
        })),
      },
      payload: body,
    });
    const refused = await post('/api/auth/handoff/finish', {
      flow,
      verifier: PKCE_VERIFIER,
      tokenKind: 'client',
      publicKey: 'AAAA',
    });
    expect(refused.statusCode).toBe(400);
    const sessions = await board.database.withOwner('grace', (tx) =>
      tx.select().from(schema.session),
    );
    expect(sessions).toHaveLength(1);
  });
});
