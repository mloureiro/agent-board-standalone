import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { tokenHash } from '@rumo/sealing';

import {
  createCredentialStore,
  createIdentityRecheck,
  ensureUser,
  SESSION_SLIDE_MS,
  type SessionDeps,
} from '../src/auth/index.js';
import { fixedClock } from '../src/clock.js';
import * as schema from '../src/db/schema/index.js';
import { openPgliteDatabase, type Database } from '../src/modules/database/index.js';
import { loadConfig, type Env } from '../src/modules/index.js';
import { createServer } from '../src/server.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { createOpenStreams } from '../src/streams.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { newSigner } from './signing.js';
import { startFakeOidc, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, type FakeOidc } from './fakes/oidc.js';
import { startFakeSaml, type FakeSaml } from './fakes/saml.js';

const PUBLIC_URL = 'http://localhost:4000';
const SP_ENTITY_ID = `${PUBLIC_URL}/saml/metadata`;
const ACS_URL = `${PUBLIC_URL}/api/auth/saml/acs`;
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const OTHER_VERIFIER = 'w'.repeat(43);
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' } as const;

interface Board {
  app: FastifyInstance;
  database: Database;
  clock: ReturnType<typeof fixedClock>;
}

interface World {
  board: Board;
  oidc: FakeOidc;
  saml: FakeSaml;
}

const NO_SAML: Env = { SAML_IDP_METADATA_URL: undefined, SAML_SP_ENTITY_ID: undefined };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const world = async (extra: Env = {}): Promise<World> => {
  const oidc = await startFakeOidc();
  const saml = await startFakeSaml(SP_ENTITY_ID, ACS_URL);
  const dataDir = mkdtempSync(join(tmpdir(), 'board-api-redirect-'));
  const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
  const config = loadConfig({
    DATABASE_URL: 'pglite:///unused',
    AUTH_MODE: 'login',
    PUBLIC_URL,
    OIDC_ISSUER: oidc.url,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    SAML_IDP_METADATA_URL: `${saml.url}/metadata`,
    SAML_SP_ENTITY_ID: SP_ENTITY_ID,
    ...extra,
  });
  if (config.signIn.mode !== 'login') throw new Error('login expected');
  const clock = fixedClock(new Date());
  const deps: SessionDeps = { database, clock, sessionDays: config.signIn.sessionDays };
  const app = await createServer(
    config,
    {
      database,
      credentials: createCredentialStore(
        deps,
        createIdentityRecheck(database, clock, config.signIn),
      ),
      streams: createOpenStreams(),
      events: createMemoryEvents(),
    },
    { clock },
  );
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await Promise.all([oidc.close(), saml.close()]);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { board: { app, database, clock }, oidc, saml };
};

const post = (app: FastifyInstance, url: string, payload: object) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS },
    payload: JSON.stringify(payload),
  });

const startOidc = async (app: FastifyInstance) =>
  (await post(app, '/api/auth/oidc/start', { challenge: CHALLENGE })).json() as { url: string };

const oidcReturn = async (w: World, mutate: (back: URL) => void = () => undefined) => {
  const { url } = await startOidc(w.board.app);
  const back = await w.oidc.authorize(url);
  mutate(back);
  return {
    code: back.searchParams.get('code') ?? '',
    state: back.searchParams.get('state') ?? '',
    iss: back.searchParams.get('iss') ?? undefined,
  };
};

const finishOidc = (w: World, returned: object, verifier = VERIFIER) =>
  post(w.board.app, '/api/auth/oidc/finish', { ...returned, verifier });

const sessionCookieOf = (answer: { cookies: { name: string; value: string }[] }): string => {
  const cookie = answer.cookies.find((candidate) => candidate.name === 'board-session');
  if (cookie === undefined) throw new Error('no session cookie');
  return cookie.value;
};

const signInWithOidc = async (w: World): Promise<string> => {
  const answer = await finishOidc(w, await oidcReturn(w));
  expect(answer.statusCode).toBe(200);
  return sessionCookieOf(answer);
};

const me = (app: FastifyInstance, token: string) =>
  app.inject({
    url: '/api/client/me',
    headers: { ...CONTRACT_HEADERS, cookie: `board-session=${token}` },
  });

const userRow = async (board: Board, username: string) =>
  (await board.database.withSystem((system) => system.lookupUser(username))) ?? null;

const bindingOf = async (board: Board, username: string) => {
  const [row] = await board.database.withOwner(username, (tx) =>
    tx
      .select({
        issuer: schema.appUser.identityIssuer,
        subject: schema.appUser.identitySubject,
      })
      .from(schema.appUser),
  );
  return row;
};

describe('OIDC', () => {
  it('[api-035] starts a code flow with PKCE S256, state and nonce', async () => {
    const w = await world();
    const { url } = await startOidc(w.board.app);
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe(`${w.oidc.url}/authorize`);
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: OIDC_CLIENT_ID,
      redirect_uri: `${PUBLIC_URL}/auth/callback`,
      scope: 'openid profile email',
      code_challenge_method: 'S256',
    });
    for (const name of ['state', 'nonce', 'code_challenge'])
      expect(target.searchParams.get(name)?.length).toBeGreaterThan(20);
  });

  it('[api-035] a returned code signs the user in with a cookie session owned by oidc', async () => {
    const w = await world();
    const token = await signInWithOidc(w);
    expect((await me(w.board.app, token)).json().username).toBe('ada');
    expect(await userRow(w.board, 'ada')).toEqual({ username: 'ada', source: 'oidc' });
    const [session] = await w.board.database.withOwner('ada', (tx) =>
      tx.select().from(schema.session),
    );
    expect(session).toMatchObject({ kind: 'cookie', method: 'oidc' });
  });

  it('[api-035] [api-037] a wrong verifier is refused and leaves the flow usable, a flow is single use', async () => {
    const w = await world();
    const returned = await oidcReturn(w);
    const wrong = await finishOidc(w, returned, OTHER_VERIFIER);
    expect(wrong.statusCode).toBe(403);
    expect(wrong.cookies).toEqual([]);
    expect((await finishOidc(w, returned)).statusCode).toBe(200);
    expect((await finishOidc(w, returned)).statusCode).toBe(403);
  });

  it('[api-035] an unknown state is refused', async () => {
    const w = await world();
    const returned = await oidcReturn(w);
    const answer = await finishOidc(w, { ...returned, state: 'x'.repeat(43) });
    expect(answer.statusCode).toBe(403);
  });

  it('[api-035] an ID token with another nonce is refused and no user is created', async () => {
    const w = await world();
    w.oidc.nonceOverride = 'another-nonce';
    const answer = await finishOidc(w, await oidcReturn(w));
    expect(answer.statusCode).toBe(403);
    expect(await userRow(w.board, 'ada')).toBeNull();
  });

  it('[api-035] a mismatching iss is refused', async () => {
    const w = await world();
    const returned = await oidcReturn(w);
    const answer = await finishOidc(w, { ...returned, iss: 'http://evil.example' });
    expect(answer.statusCode).toBe(403);
  });

  it('[api-035] a provider with no usable username claim is refused', async () => {
    const w = await world();
    w.oidc.claims = { sub: 'subject-2', groups: ['board-users'], preferred_username: '   ' };
    const answer = await finishOidc(w, await oidcReturn(w));
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error.message).toContain('no usable user name');
    expect(await userRow(w.board, 'subject-2')).toBeNull();
  });

  it('[api-035] the username falls back to the email, and OIDC_USERNAME_CLAIM picks another claim', async () => {
    const first = await world();
    first.oidc.claims = { sub: 's', email: 'Grace@Example.test', email_verified: true };
    expect((await finishOidc(first, await oidcReturn(first))).statusCode).toBe(200);
    expect(await userRow(first.board, 'grace@example.test')).not.toBeNull();

    const second = await world({ OIDC_USERNAME_CLAIM: 'sub' });
    second.oidc.claims = { sub: 'Subject-9', preferred_username: 'ignored' };
    expect((await finishOidc(second, await oidcReturn(second))).statusCode).toBe(200);
    expect(await userRow(second.board, 'subject-9')).not.toBeNull();
  });

  it('[api-035] an email username needs a verified email, a preferred username does not', async () => {
    const w = await world();
    w.oidc.claims = { sub: 's', email: 'grace@example.test' };
    const unverified = await finishOidc(w, await oidcReturn(w));
    expect(unverified.statusCode).toBe(403);
    expect(unverified.json().error.message).toContain('no usable user name');
    expect(await userRow(w.board, 'grace@example.test')).toBeNull();

    w.oidc.claims = { sub: 's', email: 'grace@example.test', email_verified: 'true' };
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(403);

    w.oidc.claims = { sub: 's', preferred_username: 'grace', email: 'g@example.test' };
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
    expect(await userRow(w.board, 'grace')).not.toBeNull();
  });

  it('[api-035] the first sign-in stores the issuer and subject, and the same identity signs in again', async () => {
    const w = await world();
    await signInWithOidc(w);
    expect(await bindingOf(w.board, 'ada')).toEqual({ issuer: w.oidc.url, subject: 'subject-1' });
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
  });

  it('[api-035] a sign-in with the same username but another subject is refused', async () => {
    const w = await world();
    await signInWithOidc(w);
    w.oidc.claims = { ...w.oidc.claims, sub: 'subject-2' };
    const answer = await finishOidc(w, await oidcReturn(w));
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error.message).toBe('sign-in failed');
    expect(answer.cookies).toEqual([]);
    expect(await bindingOf(w.board, 'ada')).toEqual({ issuer: w.oidc.url, subject: 'subject-1' });
  });

  it('[api-035] a user bound to another issuer is refused', async () => {
    const w = await world();
    await signInWithOidc(w);
    await w.board.database.withOwner('ada', (tx) =>
      tx.update(schema.appUser).set({ identityIssuer: 'https://other.example' }),
    );
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(403);
  });

  it('[api-035] a user with no binding yet is bound by the next OIDC sign-in', async () => {
    const w = await world();
    await w.board.database.withOwner('ada', (tx) => ensureUser(tx, 'ada', 'oidc'));
    expect(await bindingOf(w.board, 'ada')).toEqual({ issuer: null, subject: null });
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
    expect(await bindingOf(w.board, 'ada')).toEqual({ issuer: w.oidc.url, subject: 'subject-1' });
  });

  it('[api-035] a user outside ALLOWED_GROUPS is refused, one inside is signed in', async () => {
    const w = await world({ ...NO_SAML, ALLOWED_GROUPS: 'board-admins, ops' });
    const refused = await finishOidc(w, await oidcReturn(w));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toContain('not allowed');
    expect(await userRow(w.board, 'ada')).toBeNull();

    w.oidc.claims = { ...w.oidc.claims, groups: ['staff', 'ops'] };
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
  });

  it('[api-035] a comma-separated groups claim and a custom OIDC_GROUPS_CLAIM are read', async () => {
    const w = await world({ ...NO_SAML, ALLOWED_GROUPS: 'ops', OIDC_GROUPS_CLAIM: 'roles' });
    w.oidc.claims = { ...w.oidc.claims, roles: 'staff, ops' };
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
  });

  it('[api-035] OIDC answers not-enabled when no provider is configured', async () => {
    const w = await world({
      OIDC_ISSUER: undefined,
      OIDC_CLIENT_ID: undefined,
      OIDC_CLIENT_SECRET: undefined,
    });
    const answer = await post(w.board.app, '/api/auth/oidc/start', { challenge: CHALLENGE });
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error.code).toBe('not-enabled');
  });

  it('[api-038] a name created by another sign-in method is refused', async () => {
    const w = await world();
    await w.board.database.withOwner('ada', (tx) => ensureUser(tx, 'ada', 'passkey'));
    const answer = await finishOidc(w, await oidcReturn(w));
    expect(answer.statusCode).toBe(403);
    expect(answer.json().error.message).toContain('different sign-in method');
    expect(answer.cookies).toEqual([]);
  });

  it('[api-038] the same method signs in again to its own name', async () => {
    const w = await world();
    await signInWithOidc(w);
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
  });
});

const startSaml = async (app: FastifyInstance) =>
  (await post(app, '/api/auth/saml/start', { challenge: CHALLENGE })).json() as { url: string };

const acs = (app: FastifyInstance, response: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/saml/acs',
    headers: FORM_HEADERS,
    payload: `SAMLResponse=${encodeURIComponent(response)}`,
  });

const finishSaml = (app: FastifyInstance, flow: string, verifier = VERIFIER) =>
  post(app, '/api/auth/saml/finish', { flow, verifier });

const returnedTo = (answer: { statusCode: number; headers: Record<string, unknown> }) => {
  expect(answer.statusCode).toBe(303);
  return new URL(String(answer.headers.location));
};

const samlSignedIn = async (w: World, options?: Parameters<FakeSaml['answer']>[1]) => {
  const { url } = await startSaml(w.board.app);
  const back = returnedTo(await acs(w.board.app, w.saml.answer(url, options).SAMLResponse));
  return { url, back };
};

describe('SAML', () => {
  it('[api-036] a start sends the browser to the provider with a request that names this board', async () => {
    const w = await world();
    const { url } = await startSaml(w.board.app);
    const target = new URL(url);
    expect(target.origin + target.pathname).toBe(w.saml.entryPoint);
    expect(target.searchParams.get('SAMLRequest')).toBeTruthy();
  });

  it('[api-036] a signed assertion answered to the ACS is a 303 to the client return page with the flow', async () => {
    const w = await world();
    const { back } = await samlSignedIn(w);
    expect(back.origin + back.pathname).toBe(`${PUBLIC_URL}/auth/saml`);
    const flow = back.searchParams.get('flow') ?? '';
    expect(flow.length).toBeGreaterThan(20);
    expect(back.searchParams.has('error')).toBe(false);

    const answer = await finishSaml(w.board.app, flow);
    expect(answer.statusCode).toBe(200);
    const token = sessionCookieOf(answer);
    expect((await me(w.board.app, token)).json().username).toBe('grace@example.test');
    expect(await userRow(w.board, 'grace@example.test')).toMatchObject({ source: 'saml' });
  });

  it('[api-036] the ACS accepts the cross-site form post the identity provider makes', async () => {
    const w = await world();
    const { url } = await startSaml(w.board.app);
    const answer = await w.board.app.inject({
      method: 'POST',
      url: '/api/auth/saml/acs',
      headers: { ...FORM_HEADERS, origin: w.saml.url, 'sec-fetch-site': 'cross-site' },
      payload: `SAMLResponse=${encodeURIComponent(w.saml.answer(url).SAMLResponse)}`,
    });
    expect(returnedTo(answer).searchParams.get('flow')).toBeTruthy();
  });

  it('[api-036] the finish needs the starting browser: wrong verifier refused, flow single use', async () => {
    const w = await world();
    const { back } = await samlSignedIn(w);
    const flow = back.searchParams.get('flow') ?? '';
    expect((await finishSaml(w.board.app, flow, OTHER_VERIFIER)).statusCode).toBe(403);
    expect((await finishSaml(w.board.app, flow)).statusCode).toBe(200);
    expect((await finishSaml(w.board.app, flow)).statusCode).toBe(403);
  });

  it('[api-036] a finish before the ACS answered is refused', async () => {
    const w = await world();
    const { url } = await startSaml(w.board.app);
    const flow = w.saml.requestId(url).slice(1);
    expect((await finishSaml(w.board.app, flow)).statusCode).toBe(403);
  });

  it('[api-036] an assertion that is not signed is a 303 with an error and no flow', async () => {
    const w = await world();
    const { back } = await samlSignedIn(w, { signAssertion: false });
    expect(back.pathname).toBe('/auth/saml');
    expect(back.searchParams.get('error')).toBeTruthy();
    expect(back.searchParams.has('flow')).toBe(false);
  });

  it('[api-036] an assertion signed by another key is a 303 with an error', async () => {
    const w = await world();
    const { back } = await samlSignedIn(w, { signWithOtherKey: true });
    expect(back.searchParams.get('error')).toBeTruthy();
  });

  it('[api-036] an unsolicited response, one for another request and one for another audience are refused', async () => {
    const w = await world();
    for (const options of [
      { inResponseTo: null },
      { inResponseTo: '_unknown-request' },
      { audience: 'https://another.example/sp' },
    ]) {
      const { back } = await samlSignedIn(w, options);
      expect(back.searchParams.get('error'), JSON.stringify(options)).toBeTruthy();
    }
  });

  it('[api-036] a replayed response is refused', async () => {
    const w = await world();
    const { url } = await startSaml(w.board.app);
    const { SAMLResponse } = w.saml.answer(url);
    expect(returnedTo(await acs(w.board.app, SAMLResponse)).searchParams.has('flow')).toBe(true);
    expect(returnedTo(await acs(w.board.app, SAMLResponse)).searchParams.has('error')).toBe(true);
  });

  it('[api-036] garbage in the form is a 303 with an error, never a JSON answer', async () => {
    const w = await world();
    const back = returnedTo(await acs(w.board.app, 'not-xml'));
    expect(back.searchParams.get('error')).toBeTruthy();
  });

  it('[api-036] the ACS refuses a JSON body and answers not-enabled without SAML', async () => {
    const w = await world();
    const json = await post(w.board.app, '/api/auth/saml/acs', { SAMLResponse: 'x' });
    expect(json.statusCode).toBe(415);

    const bare = await world({ SAML_IDP_METADATA_URL: undefined, SAML_SP_ENTITY_ID: undefined });
    const answer = await acs(bare.board.app, 'x');
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error.code).toBe('not-enabled');
  });

  it('[api-038] a name created by another sign-in method is refused at the finish', async () => {
    const w = await world();
    await w.board.database.withOwner('grace@example.test', (tx) =>
      ensureUser(tx, 'grace@example.test', 'oidc'),
    );
    const { back } = await samlSignedIn(w);
    const answer = await finishSaml(w.board.app, back.searchParams.get('flow') ?? '');
    expect(answer.statusCode).toBe(403);
    expect(answer.cookies).toEqual([]);
  });

  it('[api-036] SAML_USERNAME_ATTRIBUTE names the user from an attribute', async () => {
    const w = await world({ SAML_USERNAME_ATTRIBUTE: 'groups' });
    const { back } = await samlSignedIn(w, { groups: ['Ops-Team'] });
    const answer = await finishSaml(w.board.app, back.searchParams.get('flow') ?? '');
    expect((await me(w.board.app, sessionCookieOf(answer))).json().username).toBe('ops-team');
  });
});

const advancePast = (board: Board): void =>
  board.clock.set(new Date(board.clock.now().getTime() + SESSION_SLIDE_MS + 1000));

const upkeepRow = (w: World, hash: string) =>
  w.board.database.withSystem((system) => system.getAuthFlow(`upkeep-${hash}`));

describe('identity re-check', () => {
  const signedInWithRefresh = async (extra: Env = {}) => {
    const w = await world(extra);
    w.oidc.refreshTokens = true;
    const token = await signInWithOidc(w);
    const hash = await tokenHash(token);
    return { w, token, hash };
  };

  const sessionCount = async (w: World) =>
    (await w.board.database.withOwner('ada', (tx) => tx.select().from(schema.session))).length;

  it('[api-042] a session is re-checked once the slide interval passed and rotates the stored token', async () => {
    const { w, token, hash } = await signedInWithRefresh();
    const before = (await upkeepRow(w, hash))?.data.refreshToken;
    expect(before).toBeTruthy();
    expect((await me(w.board.app, token)).statusCode).toBe(200);
    expect((await upkeepRow(w, hash))?.data.refreshToken).toBe(before);

    advancePast(w.board);
    expect((await me(w.board.app, token)).statusCode).toBe(200);
    const after = (await upkeepRow(w, hash))?.data.refreshToken;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('[api-042] a session ends when the provider no longer accepts the user', async () => {
    const { w, token, hash } = await signedInWithRefresh();
    w.oidc.revoked = true;
    advancePast(w.board);
    const answer = await me(w.board.app, token);
    expect(answer.statusCode).toBe(401);
    expect(await sessionCount(w)).toBe(0);
    expect(await upkeepRow(w, hash)).toBeNull();
    expect((await me(w.board.app, token)).statusCode).toBe(401);
  });

  it('[api-042] a session ends when the user left the allowed groups', async () => {
    const { w, token } = await signedInWithRefresh({ ...NO_SAML, ALLOWED_GROUPS: 'board-users' });
    advancePast(w.board);
    expect((await me(w.board.app, token)).statusCode).toBe(200);
    w.oidc.claims = { ...w.oidc.claims, groups: ['other'] };
    advancePast(w.board);
    expect((await me(w.board.app, token)).statusCode).toBe(401);
    expect(await sessionCount(w)).toBe(0);
  });

  it('[api-042] an unreachable provider does not sign anyone out', async () => {
    const { w, token } = await signedInWithRefresh();
    await w.oidc.close();
    advancePast(w.board);
    expect((await me(w.board.app, token)).statusCode).toBe(200);
    expect(await sessionCount(w)).toBe(1);
  });

  it('[api-042] a session of a provider that issued no refresh token is not re-checked', async () => {
    const w = await world();
    const token = await signInWithOidc(w);
    w.oidc.revoked = true;
    advancePast(w.board);
    expect((await me(w.board.app, token)).statusCode).toBe(200);
    expect(await upkeepRow(w, await tokenHash(token))).toBeNull();
  });

  it('[api-042] signing out drops the stored refresh token', async () => {
    const { w, token, hash } = await signedInWithRefresh();
    const out = await w.board.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        ...JSON_HEADERS,
        ...CONTRACT_HEADERS,
        cookie: `board-session=${token}`,
      },
      payload: '{}',
    });
    expect(out.statusCode).toBe(200);
    expect(await upkeepRow(w, hash)).toBeNull();
  });
});

describe('request-signature keys on redirect sign-in', () => {
  const boundKeys = async (w: World, owner: string) =>
    w.board.database.withOwner(owner, (tx) => tx.select().from(schema.clientKey));

  it('[api-120] an OIDC finish carrying a public key binds it to the new session', async () => {
    const w = await world({ REQUEST_SIGNATURE: 'on' });
    const signer = await newSigner();
    const answer = await finishOidc(w, {
      ...(await oidcReturn(w)),
      publicKey: signer.publicKey,
    });
    expect(answer.statusCode).toBe(200);
    expect(await boundKeys(w, 'ada')).toMatchObject([{ keyId: signer.keyId, kind: 'session' }]);
  });

  it('[api-120] a SAML finish carrying a public key binds it to the new session', async () => {
    const w = await world({ REQUEST_SIGNATURE: 'on' });
    const signer = await newSigner();
    const { back } = await samlSignedIn(w);
    const answer = await post(w.board.app, '/api/auth/saml/finish', {
      flow: back.searchParams.get('flow') ?? '',
      verifier: VERIFIER,
      publicKey: signer.publicKey,
    });
    expect(answer.statusCode).toBe(200);
    expect(await boundKeys(w, 'grace@example.test')).toMatchObject([
      { keyId: signer.keyId, kind: 'session' },
    ]);
  });

  it('[api-120] a public key is ignored while request signatures are off', async () => {
    const w = await world();
    const signer = await newSigner();
    const answer = await finishOidc(w, {
      ...(await oidcReturn(w)),
      publicKey: signer.publicKey,
    });
    expect(answer.statusCode).toBe(200);
    expect(await boundKeys(w, 'ada')).toEqual([]);
  });

  it('[api-038] a user created without a sign-in method is claimed by the first provider', async () => {
    const w = await world();
    await w.board.database.withOwner('ada', (tx) => ensureUser(tx, 'ada', null));
    expect((await finishOidc(w, await oidcReturn(w))).statusCode).toBe(200);
    expect(await userRow(w.board, 'ada')).toEqual({ username: 'ada', source: 'oidc' });
  });
});
