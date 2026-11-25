import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { tokenHash } from '@agent-board/sealing';

import {
  DAY_MS,
  SESSION_SLIDE_MS,
  createCredentialStore,
  ensureUser,
  issueSession,
  type SessionDeps,
  type SessionKind,
} from '../src/auth/index.js';
import { clockFromEnv, fixedClock } from '../src/clock.js';
import * as schema from '../src/db/schema/index.js';
import { HANDLER_SETS } from '../src/handlers/index.js';
import type { HandlerSet } from '../src/http/handler.js';
import type { RateLimitOptions } from '../src/http/sign-in-guards.js';
import { openPgliteDatabase, type Database } from '../src/modules/database/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS, MACHINE_TOKEN, SESSION_TOKEN } from './helpers.js';

const PKCE_VERIFIER = 'v'.repeat(43);
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url');
const OTHER_VERIFIER = 'w'.repeat(43);
const MINUTE = 60_000;

interface Board {
  app: FastifyInstance;
  database: Database;
  clock: ReturnType<typeof fixedClock>;
  deps: SessionDeps;
  close(): Promise<void>;
}

const open = async (
  env: Env,
  options: { handlers?: HandlerSet; rateLimit?: RateLimitOptions } = {},
): Promise<Board> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-api-sessions-'));
  const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
  const config = loadConfig({ DATABASE_URL: 'pglite:///unused', ...env });
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
    {
      clock,
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
      handlerSets: [...HANDLER_SETS, ...(options.handlers === undefined ? [] : [options.handlers])],
    },
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
const started = async (...args: Parameters<typeof open>): Promise<Board> => {
  const board = await open(...args);
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.close()));
});

const login = (extra: Env = {}): Env => ({
  AUTH_MODE: 'login',
  PUBLIC_URL: 'http://localhost:4000',
  ...extra,
});
const noLogin = (extra: Env = {}): Env => ({ NO_LOGIN_USER: 'owner', ...extra });

const signedIn = async (
  board: Board,
  owner: string,
  kind: SessionKind = 'cookie',
): Promise<string> => {
  await board.database.withOwner(owner, (tx) => ensureUser(tx, owner, 'oidc'));
  return (await issueSession(board.deps, owner, kind, 'oidc')).token;
};

const bearer = (token: string) => ({ ...CONTRACT_HEADERS, authorization: `Bearer ${token}` });
const cookieOf = (token: string) => ({ ...CONTRACT_HEADERS, cookie: `board-session=${token}` });

const post = (app: FastifyInstance, url: string, payload: object, headers: object = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, ...headers },
    payload: JSON.stringify(payload),
  });

const startHandoff = async (board: Board, challenge = PKCE_CHALLENGE) => {
  const answer = await post(board.app, '/api/auth/handoff/start', { challenge });
  return answer.json() as { flow: string; code: string };
};

const finish = (board: Board, flow: string, verifier = PKCE_VERIFIER, extra: object = {}) =>
  post(board.app, '/api/auth/handoff/finish', { flow, verifier, ...extra });

const approve = (board: Board, flow: string, headers: object) =>
  post(board.app, '/api/auth/handoff/approve', { flow }, headers);

const sessionRows = (board: Board, owner: string) =>
  board.database.withOwner(owner, (tx) => tx.select().from(schema.session));

describe('sessions', () => {
  it('[api-025] a hand-off finish stores only the hash and sets an HttpOnly SameSite=Lax cookie', async () => {
    const board = await started(login());
    const { flow } = await startHandoff(board);
    const approver = await signedIn(board, 'grace', 'client');
    expect((await approve(board, flow, bearer(approver))).statusCode).toBe(200);

    const answer = await finish(board, flow);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: 'signed-in' });
    const cookie = String(answer.headers['set-cookie']);
    const match =
      /^board-session=(abs_[A-Za-z0-9_-]{43}); Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/.exec(
        cookie,
      );
    expect(match, cookie).not.toBeNull();
    const token = match?.[1] as string;

    const rows = await sessionRows(board, 'grace');
    const hash = await tokenHash(token);
    expect(rows.map((row) => row.tokenHash)).toContain(hash);
    expect(rows.find((row) => row.tokenHash === hash)).toMatchObject({
      kind: 'cookie',
    });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('[api-025] on https the cookie is prefixed __Host- and Secure', async () => {
    const board = await started(login({ PUBLIC_URL: 'https://board.example.com' }));
    const token = await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    await approve(board, flow, {
      ...bearer(token),
      origin: 'https://board.example.com',
    });
    const answer = await finish(board, flow);
    expect(String(answer.headers['set-cookie'])).toMatch(
      /^__Host-board-session=abs_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/,
    );
  });

  it('[api-026] a cookie session is read only from its cookie and an unknown cookie is cleared', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace');

    const viaCookie = await board.app.inject({ url: '/api/client/me', headers: cookieOf(token) });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().username).toBe('grace');

    const viaBearer = await board.app.inject({ url: '/api/client/me', headers: bearer(token) });
    expect(viaBearer.statusCode).toBe(401);

    const unknown = await board.app.inject({
      url: '/api/client/me',
      headers: cookieOf(SESSION_TOKEN),
    });
    expect(unknown.statusCode).toBe(401);
    expect(String(unknown.headers['set-cookie'])).toMatch(/^board-session=; .*Max-Age=0/);
  });

  it('[api-026] Authorization accepts abc_ client tokens and abm_ machine tokens', async () => {
    const board = await started(login());
    const client = await signedIn(board, 'grace', 'client');
    const asClient = await board.app.inject({ url: '/api/client/me', headers: bearer(client) });
    expect(asClient.json().username).toBe('grace');

    await board.database.withOwner('grace', (tx) =>
      tx.insert(schema.machine).values({ id: 'laptop', tokenHash: '0'.repeat(64) }),
    );
    const store = createCredentialStore(board.deps);
    expect(await store.findMachine('0'.repeat(64))).toEqual({
      owner: 'grace',
      machineId: 'laptop',
    });
    expect(MACHINE_TOKEN).toMatch(/^abm_/);
  });

  it('[api-026] a revoked machine token is unknown', async () => {
    const board = await started(login());
    await board.database.withOwner('grace', (tx) => ensureUser(tx, 'grace', 'oidc'));
    await board.database.withOwner('grace', (tx) =>
      tx
        .insert(schema.machine)
        .values({ id: 'laptop', tokenHash: '1'.repeat(64), revokedAt: new Date() }),
    );
    expect(await createCredentialStore(board.deps).findMachine('1'.repeat(64))).toBeNull();
  });

  it('[api-027] a session expires after SESSION_DAYS without use and a use slides it at most once an hour', async () => {
    const board = await started(login({ SESSION_DAYS: '7' }));
    const token = await signedIn(board, 'grace');
    const hash = await tokenHash(token);
    const expiryOf = async () =>
      (await sessionRows(board, 'grace'))
        .find((row) => row.tokenHash === hash)
        ?.expiresAt.getTime() ?? 0;
    const start = board.clock.now().getTime();
    const useResponse = () =>
      board.app.inject({ url: '/api/client/me', headers: cookieOf(token) });
    const use = async () => (await useResponse()).statusCode;

    expect(await expiryOf()).toBe(start + 7 * DAY_MS);

    board.clock.set(new Date(start + 30 * MINUTE));
    const notSlid = await useResponse();
    expect(notSlid.statusCode).toBe(200);
    expect(notSlid.headers['set-cookie']).toBeUndefined();
    expect(await expiryOf()).toBe(start + 7 * DAY_MS);

    board.clock.set(new Date(start + SESSION_SLIDE_MS));
    const slid = await useResponse();
    expect(slid.statusCode).toBe(200);
    expect(slid.headers['set-cookie']).toContain(`=${token}; `);
    expect(slid.headers['set-cookie']).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(await expiryOf()).toBe(start + SESSION_SLIDE_MS + 7 * DAY_MS);

    board.clock.set(new Date(start + SESSION_SLIDE_MS + 7 * DAY_MS + 1));
    const expired = await board.app.inject({ url: '/api/client/me', headers: cookieOf(token) });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.message).toMatch(/expired/);
    expect(expired.headers['set-cookie']).toBeUndefined();
  });

  it('[api-027] the default is 30 days and SESSION_DAYS must be a whole number from 1 to 365', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace');
    const [row] = await sessionRows(board, 'grace');
    expect(row?.expiresAt.getTime()).toBe(board.clock.now().getTime() + 30 * DAY_MS);
    expect(token).toBeDefined();
    for (const value of ['0', '366', '1.5', 'abc', '-3']) {
      expect(() =>
        loadConfig({ DATABASE_URL: 'pglite:///x', ...login({ SESSION_DAYS: value }) }),
      ).toThrow(/SESSION_DAYS/);
    }
  });

  it('[api-028] logout deletes only the current session and clears the cookie', async () => {
    const board = await started(login());
    const current = await signedIn(board, 'grace');
    const other = await issueSession(board.deps, 'grace', 'cookie', 'oidc');

    const answer = await post(board.app, '/api/auth/logout', {}, cookieOf(current));
    expect(answer.statusCode).toBe(200);
    expect(String(answer.headers['set-cookie'])).toMatch(/^board-session=; .*Max-Age=0/);

    const gone = await board.app.inject({ url: '/api/client/me', headers: cookieOf(current) });
    expect(gone.statusCode).toBe(401);
    const kept = await board.app.inject({ url: '/api/client/me', headers: cookieOf(other.token) });
    expect(kept.statusCode).toBe(200);
  });
});

describe('client tokens', () => {
  it('[api-114] an abc_ token is a session row of kind client with the same expiry and sliding', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const [row] = await sessionRows(board, 'grace');
    expect(row).toMatchObject({ kind: 'client', method: 'oidc' });
    expect(row?.tokenHash).toBe(await tokenHash(token));

    const start = board.clock.now().getTime();
    board.clock.set(new Date(start + 29 * DAY_MS));
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: bearer(token) })).statusCode,
    ).toBe(200);
    board.clock.set(new Date(start + 31 * DAY_MS));
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: bearer(token) })).statusCode,
    ).toBe(200);
    board.clock.set(new Date(start + 62 * DAY_MS));
    const expired = await board.app.inject({ url: '/api/client/me', headers: bearer(token) });
    expect(expired.statusCode).toBe(401);
  });

  it('[api-114] a cookie value in Authorization and a client token in the cookie are both refused', async () => {
    const board = await started(login());
    const cookie = await signedIn(board, 'grace');
    const client = await signedIn(board, 'grace', 'client');
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: bearer(cookie) })).statusCode,
    ).toBe(401);
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: cookieOf(client) })).statusCode,
    ).toBe(401);
  });

  it('[api-114] logout with the token deletes only that session', async () => {
    const board = await started(login());
    const first = await signedIn(board, 'grace', 'client');
    const second = await signedIn(board, 'grace', 'client');
    expect((await post(board.app, '/api/auth/logout', {}, bearer(first))).statusCode).toBe(200);
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: bearer(first) })).statusCode,
    ).toBe(401);
    expect(
      (await board.app.inject({ url: '/api/client/me', headers: bearer(second) })).statusCode,
    ).toBe(200);
  });
});

describe('hand-off', () => {
  it('[api-039] a start returns an XXXX-XXXX code a signed-in user can read back', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const { flow, code } = await startHandoff(board);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const described = await board.app.inject({
      url: `/api/auth/handoff/describe?flow=${flow}`,
      headers: bearer(token),
    });
    expect(described.json()).toEqual({ code });
    const unknown = await board.app.inject({
      url: '/api/auth/handoff/describe?flow=nope',
      headers: bearer(token),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('[api-039] a finish before approval grants no session', async () => {
    const board = await started(login());
    const { flow } = await startHandoff(board);
    const answer = await finish(board, flow);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: 'pending' });
    expect(answer.headers['set-cookie']).toBeUndefined();
  });

  it('[api-039] [api-037] a wrong verifier is refused, grants nothing and leaves the flow usable', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    await approve(board, flow, bearer(token));

    const wrong = await finish(board, flow, OTHER_VERIFIER);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('forbidden');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    expect((await finish(board, flow)).json()).toEqual({ status: 'signed-in' });
  });

  it('[api-039] [api-037] a flow is single use: a second finish is refused and sets nothing', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    await approve(board, flow, bearer(token));
    const first = await finish(board, flow);
    expect(first.statusCode).toBe(200);
    const sessions = (await sessionRows(board, 'grace')).length;
    const second = await finish(board, flow);
    expect(second.statusCode).toBe(403);
    expect(second.headers['set-cookie']).toBeUndefined();
    expect((await sessionRows(board, 'grace')).length).toBe(sessions);
  });

  it('[api-039] [api-037] a flow approved at 9 minutes still finishes, an unapproved one is refused after 10', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const late = await startHandoff(board);
    const start = board.clock.now().getTime();
    board.clock.set(new Date(start + 9 * MINUTE));
    expect((await approve(board, late.flow, bearer(token))).statusCode).toBe(200);
    expect((await finish(board, late.flow)).json()).toEqual({ status: 'signed-in' });

    const idle = await startHandoff(board);
    board.clock.set(new Date(start + 9 * MINUTE + 10 * MINUTE + 1));
    expect((await approve(board, idle.flow, bearer(token))).statusCode).toBe(404);
    expect((await finish(board, idle.flow)).statusCode).toBe(403);
  });

  it('[api-039] [api-114] tokenKind client returns an abc_ token in the body and sets no cookie', async () => {
    const board = await started(login());
    const token = await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    await approve(board, flow, bearer(token));
    const answer = await finish(board, flow, PKCE_VERIFIER, { tokenKind: 'client' });
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { status: string; token: string };
    expect(body.status).toBe('signed-in');
    expect(body.token).toMatch(/^abc_[A-Za-z0-9_-]{43}$/);
    expect(answer.headers['set-cookie']).toBeUndefined();
    const me = await board.app.inject({ url: '/api/client/me', headers: bearer(body.token) });
    expect(me.json().username).toBe('grace');
    const rows = await sessionRows(board, 'grace');
    expect(rows.map((row) => row.tokenHash)).toContain(await tokenHash(body.token));
  });

  it('[api-039] the session belongs to the approving user', async () => {
    const board = await started(login());
    const ada = await signedIn(board, 'ada', 'client');
    await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    await approve(board, flow, bearer(ada));
    const answer = await finish(board, flow, PKCE_VERIFIER, { tokenKind: 'client' });
    const me = await board.app.inject({
      url: '/api/client/me',
      headers: bearer(answer.json().token),
    });
    expect(me.json().username).toBe('ada');
  });

  it('[api-039] two concurrent approvals leave the first approver as the owner', async () => {
    const board = await started(login());
    const ada = await signedIn(board, 'ada', 'client');
    const grace = await signedIn(board, 'grace', 'client');
    const { flow } = await startHandoff(board);
    const answers = await Promise.all([
      approve(board, flow, bearer(ada)),
      approve(board, flow, bearer(grace)),
    ]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 403]);
    const winner = answers[0]?.statusCode === 200 ? 'ada' : 'grace';
    const answer = await finish(board, flow, PKCE_VERIFIER, { tokenKind: 'client' });
    const me = await board.app.inject({
      url: '/api/client/me',
      headers: bearer(answer.json().token),
    });
    expect(me.json().username).toBe(winner);
  });

  it('[api-039] approving without a session is refused', async () => {
    const board = await started(login());
    const { flow } = await startHandoff(board);
    const answer = await approve(board, flow, CONTRACT_HEADERS);
    expect(answer.statusCode).toBe(401);
  });
});

describe('no-login mode', () => {
  const writer: HandlerSet = (context) => ({
    'client.projects.create': async ({ principal, input }) => {
      await context.services.database.withOwner(principal.owner, async (tx) => {
        await tx.insert(schema.project).values({ id: randomUUID(), isDefault: false, position: 1 });
        if (input.position === 99) throw new Error('rolled back');
      });
      return {};
    },
  });

  const create = (board: Board, position = 1) =>
    post(
      board.app,
      '/api/client/projects/create',
      {
        id: randomUUID(),
        name: `abe1.${'A'.repeat(40)}`,
        icon: null,
        position,
      },
      CONTRACT_HEADERS,
    );

  const users = (board: Board) =>
    board.database.withOwner('owner', (tx) =>
      tx.select().from(schema.appUser).where(eq(schema.appUser.username, 'owner')),
    );
  const projects = (board: Board) =>
    board.database.withOwner('owner', (tx) => tx.select().from(schema.project));

  it('[api-029] every client request is the configured user and reads create no user row', async () => {
    const board = await started(noLogin(), { handlers: writer });
    const me = await board.app.inject({ url: '/api/client/me', headers: CONTRACT_HEADERS });
    expect(me.json()).toEqual({ username: 'owner', keyId: null });
    expect(await users(board)).toEqual([]);
  });

  it('[api-029] the first committed write creates the user and its default project together', async () => {
    const board = await started(noLogin(), { handlers: writer });
    expect((await create(board)).statusCode).toBe(200);
    expect(await users(board)).toHaveLength(1);
    const rows = await projects(board);
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
    expect(rows).toHaveLength(2);

    expect((await create(board)).statusCode).toBe(200);
    expect(await users(board)).toHaveLength(1);
    expect((await projects(board)).filter((row) => row.isDefault)).toHaveLength(1);
  });

  it('[api-029] a write that rolls back leaves no user row', async () => {
    const board = await started(noLogin(), { handlers: writer });
    expect((await create(board, 99)).statusCode).toBe(500);
    expect(await users(board)).toEqual([]);
    expect(await projects(board)).toEqual([]);
  });

  it('[api-029] concurrent first writes create one user and one default project', async () => {
    const board = await started(noLogin(), { handlers: writer });
    const answers = await Promise.all([create(board), create(board), create(board)]);
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200]);
    expect(await users(board)).toHaveLength(1);
    expect((await projects(board)).filter((row) => row.isDefault)).toHaveLength(1);
  });

  it('[api-040] every sign-in route answers "This board runs without login." as not found', async () => {
    const board = await started(noLogin());
    const checks: [string, 'GET' | 'POST', object?][] = [
      ['/api/auth/oidc/start', 'POST', { challenge: PKCE_CHALLENGE }],
      ['/api/auth/saml/start', 'POST', { challenge: PKCE_CHALLENGE }],
      ['/api/auth/passkey/login-options', 'POST', {}],
      ['/api/auth/handoff/start', 'POST', { challenge: PKCE_CHALLENGE }],
      ['/api/auth/handoff/finish', 'POST', { flow: 'x', verifier: PKCE_VERIFIER }],
      ['/api/auth/handoff/approve', 'POST', { flow: 'x' }],
      ['/api/auth/handoff/describe?flow=x', 'GET'],
    ];
    for (const [url, method, payload] of checks) {
      const answer = await board.app.inject({
        method,
        url,
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      expect(answer.statusCode, url).toBe(404);
      expect(answer.json().error, url).toEqual({
        code: 'not-found',
        message: 'This board runs without login.',
      });
    }
  });

  it('[api-031] the public config says login is off', async () => {
    const board = await started(noLogin());
    const answer = await board.app.inject({ url: '/api/auth/config' });
    expect(answer.json()).toEqual({ login: false });
    const version = await board.app.inject({ url: '/api/version' });
    expect(version.json().modules.signIn).toEqual([]);
    expect(version.json().session).toBe('not-required');
  });
});

describe('sign-in methods', () => {
  it('[api-031] the public config lists what is offered, and the version lists the same methods', async () => {
    const board = await started(
      login({
        PASSKEYS: 'on',
        SIGNUP_TOKEN: 's'.repeat(40),
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'board',
        OIDC_CLIENT_SECRET: 'secret',
      }),
    );
    const answer = await board.app.inject({ url: '/api/auth/config' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      login: true,
      passkeys: true,
      signup: true,
      oidc: { label: 'OpenID Connect' },
      saml: null,
    });
    const version = await board.app.inject({ url: '/api/version' });
    expect(version.json().modules.signIn).toEqual(['passkeys', 'handoff', 'oidc']);
  });

  it('[api-031] with passkeys off and no signup token only hand-off and the configured methods remain', async () => {
    const board = await started(
      login({ PASSKEYS: 'off', SAML_IDP_METADATA_URL: 'https://idp.example/metadata' }),
    );
    const answer = await board.app.inject({ url: '/api/auth/config' });
    expect(answer.json()).toEqual({
      login: true,
      passkeys: false,
      signup: false,
      oidc: null,
      saml: { label: 'SAML' },
    });
  });
});

describe('rate limiting', () => {
  it('[api-041] a public sign-in route answers 429 with Retry-After after the limit', async () => {
    const board = await started(login(), { rateLimit: { max: 3, windowMs: MINUTE } });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const answer = await post(board.app, '/api/auth/handoff/start', {
        challenge: PKCE_CHALLENGE,
      });
      statuses.push(answer.statusCode);
      if (answer.statusCode === 429) {
        expect(answer.json().error.code).toBe('too-many-requests');
        expect(Number(answer.headers['retry-after'])).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('[api-041] each route counts on its own and other routes are never limited', async () => {
    const board = await started(login(), { rateLimit: { max: 1, windowMs: MINUTE } });
    expect(
      (await post(board.app, '/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })).statusCode,
    ).toBe(200);
    expect(
      (await post(board.app, '/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })).statusCode,
    ).toBe(429);
    expect((await finish(board, 'unknown')).statusCode).toBe(403);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await board.app.inject({ url: '/api/auth/config' })).statusCode).toBe(200);
      expect((await board.app.inject({ url: '/api/version' })).statusCode).toBe(200);
    }
  });

  it('[api-041] the window resets after its length', async () => {
    const board = await started(login(), { rateLimit: { max: 1, windowMs: 50 } });
    expect(
      (await post(board.app, '/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })).statusCode,
    ).toBe(200);
    expect(
      (await post(board.app, '/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })).statusCode,
    ).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      (await post(board.app, '/api/auth/handoff/start', { challenge: PKCE_CHALLENGE })).statusCode,
    ).toBe(200);
  });
});

describe('request bodies', () => {
  it('[api-026] a body that tries to poison the prototype is refused as a bad request', async () => {
    const board = await started(login());
    for (const payload of ['{"__proto__":{"x":1}}', '{"constructor":{"prototype":{"x":1}}}']) {
      const answer = await board.app.inject({
        method: 'POST',
        url: '/api/auth/handoff/start',
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
        payload,
      });
      expect(answer.statusCode, payload).toBe(400);
    }
    const empty = await board.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, cookie: 'board-session=x' },
      payload: '',
    });
    expect(empty.statusCode).toBe(401);
  });
});

describe('origins and CORS', () => {
  const origin = 'https://app.example.com';

  it('[api-113] an allowed origin gets CORS headers naming it, the contract headers and no credentials', async () => {
    const board = await started(noLogin({ ALLOWED_ORIGINS: `${origin},tauri://localhost` }));
    const answer = await board.app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, origin },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['access-control-allow-origin']).toBe(origin);
    expect(answer.headers['vary']).toMatch(/Origin/);
    expect(String(answer.headers['access-control-allow-headers'])).toMatch(
      /x-board-contract.*x-board-key.*x-board-sig.*authorization/,
    );
    expect(answer.headers['access-control-allow-credentials']).toBeUndefined();

    const native = await board.app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, origin: 'tauri://localhost' },
    });
    expect(native.headers['access-control-allow-origin']).toBe('tauri://localhost');
  });

  it('[api-113] a refused answer from an allowed origin still carries the CORS headers', async () => {
    const board = await started(login({ ALLOWED_ORIGINS: origin }));
    const answer = await board.app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, origin },
    });
    expect(answer.statusCode).toBe(401);
    expect(answer.headers['access-control-allow-origin']).toBe(origin);
  });

  it('[api-113] a foreign origin gets no CORS headers', async () => {
    const board = await started(noLogin({ ALLOWED_ORIGINS: origin }));
    const answer = await board.app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, origin: 'https://evil.example' },
    });
    expect(answer.headers['access-control-allow-origin']).toBeUndefined();
    expect(answer.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('[api-113] the version document answers Access-Control-Allow-Origin * to any origin', async () => {
    const board = await started(noLogin({ ALLOWED_ORIGINS: origin }));
    for (const from of ['https://evil.example', origin]) {
      const answer = await board.app.inject({ url: '/api/version', headers: { origin: from } });
      expect(answer.headers['access-control-allow-origin'], from).toBe('*');
      expect(answer.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('[api-113] a preflight from an allowed origin is answered with 204 and the allowed headers', async () => {
    const board = await started(noLogin({ ALLOWED_ORIGINS: origin }));
    const answer = await board.app.inject({
      method: 'OPTIONS',
      url: '/api/client/tasks/list',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-board-contract, authorization, content-type',
      },
    });
    expect(answer.statusCode).toBe(204);
    expect(answer.headers['access-control-allow-origin']).toBe(origin);
    expect(String(answer.headers['access-control-allow-methods'])).toMatch(/POST/);
    expect(String(answer.headers['access-control-allow-headers'])).toMatch(/authorization/);
    expect(answer.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('[api-113] a preflight from another origin is not granted, except on the version document', async () => {
    const board = await started(noLogin({ ALLOWED_ORIGINS: origin }));
    const foreign = await board.app.inject({
      method: 'OPTIONS',
      url: '/api/client/tasks/list',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const version = await board.app.inject({
      method: 'OPTIONS',
      url: '/api/version',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(version.statusCode).toBe(204);
    expect(version.headers['access-control-allow-origin']).toBe('*');
  });

  it('[api-107] a request without Origin that the browser marks cross-site is refused', async () => {
    const board = await started(noLogin());
    const answer = await post(
      board.app,
      '/api/auth/logout',
      {},
      { 'sec-fetch-site': 'cross-site' },
    );
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error.code).toBe('origin-refused');
  });

  it('[api-107] the own origin of a server on port 80 has no port', async () => {
    const board = await started(noLogin({ PORT: '80', HOST: '127.0.0.1' }));
    const own = await post(board.app, '/api/auth/logout', {}, { origin: 'http://127.0.0.1' });
    expect(own.statusCode).toBe(200);
    const withPort = await post(
      board.app,
      '/api/auth/logout',
      {},
      { origin: 'http://127.0.0.1:80' },
    );
    expect(withPort.statusCode).toBe(200);
    const other = await post(board.app, '/api/auth/logout', {}, { origin: 'http://127.0.0.1:81' });
    expect(other.statusCode).toBe(403);
  });
});

describe('test clock', () => {
  it('[api-027] the clock offset file moves time only when the E2E switch is on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-api-clock-'));
    const file = join(dir, 'offset');
    writeFileSync(file, '3600');
    const shifted = clockFromEnv({ AGENT_BOARD_E2E: '1', AGENT_BOARD_CLOCK_OFFSET_FILE: file });
    expect(shifted.now().getTime() - Date.now()).toBeGreaterThan(3_590_000);
    const plain = clockFromEnv({ AGENT_BOARD_CLOCK_OFFSET_FILE: file });
    expect(Math.abs(plain.now().getTime() - Date.now())).toBeLessThan(1000);
    writeFileSync(file, 'garbage');
    expect(Math.abs(shifted.now().getTime() - Date.now())).toBeLessThan(1000);
    rmSync(dir, { recursive: true, force: true });
  });
});
