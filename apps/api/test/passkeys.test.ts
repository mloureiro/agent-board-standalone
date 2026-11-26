import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { admitUser, ensureUser, issueSession } from '../src/auth/index.js';
import * as schema from '../src/db/schema/index.js';
import type { Env } from '../src/modules/index.js';
import { CONTRACT_HEADERS, JSON_HEADERS } from './helpers.js';
import { openPgliteBoard, type PgliteBoard } from './pglite-board.js';
import { SoftwareAuthenticator } from './software-authenticator.js';
import { newSigner } from './signing.js';

const ORIGIN = 'http://localhost:4000';
const RP_ID = 'localhost';
const SIGNUP_TOKEN = 's'.repeat(40);

const boards: PgliteBoard[] = [];
const started = async (extra: Env = {}): Promise<PgliteBoard> => {
  const board = await openPgliteBoard({
    AUTH_MODE: 'login',
    PUBLIC_URL: ORIGIN,
    SIGNUP_TOKEN,
    ...extra,
  });
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.close()));
});

const authenticator = () => new SoftwareAuthenticator(ORIGIN, RP_ID);

const post = (app: FastifyInstance, url: string, payload: object, headers: object = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, ...headers },
    payload: JSON.stringify(payload),
  });

const signUpOptions = (board: PgliteBoard, username: string, signupToken = SIGNUP_TOKEN) =>
  post(board.app, '/api/auth/passkey/signup-options', { username, signupToken });

const signUp = async (
  board: PgliteBoard,
  device: SoftwareAuthenticator,
  username: string,
  extra: { name?: string } = {},
): Promise<LightMyRequestResponse> => {
  const begun = (await signUpOptions(board, username)).json();
  return post(board.app, '/api/auth/passkey/signup', {
    flow: begun.flow,
    response: device.register({ challenge: begun.options.challenge }),
    ...extra,
  });
};

const cookieFrom = (answer: LightMyRequestResponse): string =>
  /board-session=(abs_[A-Za-z0-9_-]{43})/.exec(String(answer.headers['set-cookie']))?.[1] ?? '';

const asUser = (token: string) => ({ cookie: `board-session=${token}`, origin: ORIGIN });

const passkeyRows = (board: PgliteBoard, owner: string) =>
  board.database.withOwner(owner, (tx) => tx.select().from(schema.passkey));

const loginBegin = async (board: PgliteBoard) =>
  (await post(board.app, '/api/auth/passkey/login-options', {})).json() as {
    flow: string;
    options: { challenge: string };
  };

const registered = async (board: PgliteBoard, username = 'ada') => {
  const device = authenticator();
  const answer = await signUp(board, device, username);
  expect(answer.statusCode, answer.body).toBe(200);
  return { device, token: cookieFrom(answer) };
};

const loginWith = (board: PgliteBoard, flow: string, response: object) =>
  post(board.app, '/api/auth/passkey/login', { flow, response });

describe('passkey login', () => {
  it('[api-032] login-options asks for a discoverable, user-verified credential', async () => {
    const board = await started();
    const answer = await post(board.app, '/api/auth/passkey/login-options', {});
    expect(answer.statusCode).toBe(200);
    const { options, flow } = answer.json();
    expect(flow).toEqual(expect.any(String));
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe(RP_ID);
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it('[api-032] a known passkey signs in, stores the counter and sets a session cookie', async () => {
    const board = await started();
    const { device } = await registered(board);
    const { flow, options } = await loginBegin(board);

    const answer = await loginWith(board, flow, device.assert({ challenge: options.challenge }));
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toEqual({ ok: true });
    const token = cookieFrom(answer);
    expect(token).not.toBe('');

    const me = await board.app.inject({
      url: '/api/client/me',
      headers: { ...CONTRACT_HEADERS, cookie: `board-session=${token}` },
    });
    expect(me.json().username).toBe('ada');
    const [row] = await passkeyRows(board, 'ada');
    expect(row?.counter).toBe(1);
    expect(row?.lastUsedAt).not.toBeNull();
    const sessions = await board.database.withOwner('ada', (tx) =>
      tx.select().from(schema.session),
    );
    expect(sessions.some((session) => session.method === 'passkey')).toBe(true);
  });

  it('[api-120] a passkey login carrying a public key binds it to the new session when signatures are on', async () => {
    const board = await started({ REQUEST_SIGNATURE: 'on' });
    const { device } = await registered(board);
    const { flow, options } = await loginBegin(board);
    const signer = await newSigner();
    const answer = await post(board.app, '/api/auth/passkey/login', {
      flow,
      response: device.assert({ challenge: options.challenge }),
      publicKey: signer.publicKey,
    });
    expect(answer.statusCode, answer.body).toBe(200);
    const keys = await board.database.withOwner('ada', (tx) => tx.select().from(schema.clientKey));
    expect(keys).toMatchObject([{ keyId: signer.keyId, kind: 'session' }]);
  });

  it('[api-032] an unknown credential is refused and sets no cookie', async () => {
    const board = await started();
    await registered(board);
    const stranger = authenticator();
    const { flow, options } = await loginBegin(board);
    const answer = await loginWith(board, flow, stranger.assert({ challenge: options.challenge }));
    expect(answer.statusCode).toBe(403);
    expect(answer.headers['set-cookie']).toBeUndefined();
  });

  it('[api-032] a wrong challenge, a wrong origin and a missing user verification are refused', async () => {
    const board = await started();
    const { device } = await registered(board);
    const attempts = (challenge: string) => [
      device.assert({ challenge: 'AAAA' }),
      device.assert({ challenge, origin: 'http://evil.example' }),
      device.assert({ challenge, userVerified: false }),
      device.assert({ challenge, rpId: 'evil.example' }),
      device.assert({ challenge, type: 'webauthn.create' }),
    ];
    for (let index = 0; index < 5; index += 1) {
      const { flow, options } = await loginBegin(board);
      const answer = await loginWith(board, flow, attempts(options.challenge)[index] as object);
      expect(answer.statusCode, `attempt ${index}`).toBe(403);
    }
    expect((await passkeyRows(board, 'ada'))[0]?.counter).toBe(0);
  });

  it('[api-032] a counter that did not advance is refused and the stored counter stays', async () => {
    const board = await started();
    const { device } = await registered(board);
    const first = await loginBegin(board);
    expect(
      (
        await loginWith(
          board,
          first.flow,
          device.assert({ challenge: first.options.challenge, counter: 5 }),
        )
      ).statusCode,
    ).toBe(200);

    for (const counter of [5, 4]) {
      const next = await loginBegin(board);
      const answer = await loginWith(
        board,
        next.flow,
        device.assert({ challenge: next.options.challenge, counter }),
      );
      expect(answer.statusCode).toBe(403);
    }
    expect((await passkeyRows(board, 'ada'))[0]?.counter).toBe(5);

    const last = await loginBegin(board);
    expect(
      (
        await loginWith(
          board,
          last.flow,
          device.assert({ challenge: last.options.challenge, counter: 6 }),
        )
      ).statusCode,
    ).toBe(200);
  });

  it('[api-032] a login flow is single use and expires after ten minutes', async () => {
    const board = await started();
    const { device } = await registered(board);
    const used = await loginBegin(board);
    const response = device.assert({ challenge: used.options.challenge });
    expect((await loginWith(board, used.flow, response)).statusCode).toBe(200);
    const replay = await loginWith(
      board,
      used.flow,
      device.assert({ challenge: used.options.challenge }),
    );
    expect(replay.statusCode).toBe(403);

    const stale = await loginBegin(board);
    board.clock.set(new Date(board.clock.now().getTime() + 10 * 60_000 + 1));
    const late = await loginWith(
      board,
      stale.flow,
      device.assert({ challenge: stale.options.challenge }),
    );
    expect(late.statusCode).toBe(403);
  });

  it('[api-032] passkeys switched off answer not-enabled on every passkey route', async () => {
    const board = await started({
      PASSKEYS: 'off',
      SIGNUP_TOKEN: undefined,
      OIDC_ISSUER: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'board',
      OIDC_CLIENT_SECRET: 'secret',
    } as Env);
    const answer = await post(board.app, '/api/auth/passkey/login-options', {});
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error.code).toBe('not-enabled');
  });
});

describe('passkey sign-up', () => {
  it('[api-033] sign-up creates the user and the default project, stores the passkey and signs in', async () => {
    const board = await started();
    const device = authenticator();
    const answer = await signUp(board, device, 'ada', { name: 'Laptop' });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(cookieFrom(answer)).not.toBe('');

    const user = await board.database.withSystem((system) => system.lookupUser('ada'));
    expect(user).toEqual({ username: 'ada', source: 'passkey' });
    const projects = await board.database.withOwner('ada', (tx) =>
      tx.select().from(schema.project),
    );
    expect(projects.filter((project) => project.isDefault)).toHaveLength(1);
    const [row] = await passkeyRows(board, 'ada');
    expect(row).toMatchObject({ credentialId: device.credentialId, name: 'Laptop', counter: 0 });
  });

  it('[api-033] the passkey is named Passkey when sign-up gives no name', async () => {
    const board = await started();
    await registered(board);
    expect((await passkeyRows(board, 'ada'))[0]?.name).toBe('Passkey');
  });

  it('[api-033] sign-up needs the sign-up token and says nothing about names without it', async () => {
    const board = await started();
    await registered(board);
    const wrong = await signUpOptions(board, 'ada', 'x'.repeat(40));
    expect(wrong.statusCode).toBe(403);
    const free = await signUpOptions(board, 'grace', 'x'.repeat(40));
    expect(free.statusCode).toBe(403);
    expect(free.json().error.message).toBe(wrong.json().error.message);
  });

  it('[api-033] sign-up is closed when the board has no sign-up token', async () => {
    const board = await started({ SIGNUP_TOKEN: undefined } as Env);
    const answer = await signUpOptions(board, 'ada');
    expect(answer.statusCode).toBe(403);
  });

  it('[api-033] a name must match the name rule and is lower-cased', async () => {
    const board = await started();
    for (const name of ['', '-ada', '.ada', 'a b', 'ada!', 'a'.repeat(65), 'ada/../x']) {
      const answer = await signUpOptions(board, name);
      expect(answer.statusCode, name).toBe(400);
    }
    for (const name of ['a', 'a'.repeat(64), 'a.b_c-d@e', '0day']) {
      expect((await signUpOptions(board, name)).statusCode, name).toBe(200);
    }
    const device = authenticator();
    expect((await signUp(board, device, '  Ada  ')).statusCode).toBe(200);
    expect(await board.database.withSystem((system) => system.lookupUser('ada'))).not.toBeNull();
  });

  it('[api-033] a taken name is refused at options and at the end of a raced sign-up', async () => {
    const board = await started();
    await registered(board);
    expect((await signUpOptions(board, 'ada')).statusCode).toBe(403);

    const first = (await signUpOptions(board, 'grace')).json();
    const second = (await signUpOptions(board, 'grace')).json();
    const one = authenticator();
    const two = authenticator();
    const winner = await post(board.app, '/api/auth/passkey/signup', {
      flow: first.flow,
      response: one.register({ challenge: first.options.challenge }),
    });
    const loser = await post(board.app, '/api/auth/passkey/signup', {
      flow: second.flow,
      response: two.register({ challenge: second.options.challenge }),
    });
    expect(winner.statusCode).toBe(200);
    expect(loser.statusCode).toBe(403);
    expect(loser.headers['set-cookie']).toBeUndefined();
    expect(await passkeyRows(board, 'grace')).toHaveLength(1);
  });

  it('[api-033] a name taken by another sign-in method is refused', async () => {
    const board = await started();
    await board.database.withOwner('grace', (tx) => ensureUser(tx, 'grace', 'oidc'));
    expect((await signUpOptions(board, 'grace')).statusCode).toBe(403);
  });

  it('[api-033] a name with no sign-in method yet is taken without a claimed name', async () => {
    const board = await started();
    await board.database.withOwner('owner', (tx) => ensureUser(tx, 'owner', null));
    expect((await signUpOptions(board, 'owner')).statusCode).toBe(403);
  });

  it('[api-033] the claimed name takes over its account once, keeping its data, and signs in', async () => {
    const board = await started({ CLAIM_USER: 'owner' } as Env);
    await board.database.withOwner('owner', (tx) => ensureUser(tx, 'owner', null));
    const before = await board.database.withOwner('owner', (tx) =>
      tx.select().from(schema.project),
    );

    const device = authenticator();
    const answer = await signUp(board, device, 'owner');
    expect(answer.statusCode, answer.body).toBe(200);
    expect(cookieFrom(answer)).not.toBe('');
    expect(await board.database.withSystem((system) => system.lookupUser('owner'))).toEqual({
      username: 'owner',
      source: 'passkey',
    });
    expect(
      await board.database.withOwner('owner', (tx) => tx.select().from(schema.project)),
    ).toEqual(before);
    expect(await passkeyRows(board, 'owner')).toHaveLength(1);

    expect((await signUpOptions(board, 'owner')).statusCode).toBe(403);
  });

  it('[api-033] a claimed name refuses every other name and never takes an account with a method', async () => {
    const board = await started({ CLAIM_USER: 'owner' } as Env);
    const other = await signUpOptions(board, 'grace');
    expect(other.statusCode).toBe(403);
    expect(other.json().error.message).toContain('only to the account being set up');

    await board.database.withOwner('owner', (tx) => ensureUser(tx, 'owner', 'oidc'));
    expect((await signUpOptions(board, 'owner')).statusCode).toBe(403);
  });

  it('[api-033] a claimed name that does not exist yet is created by sign-up', async () => {
    const board = await started({ CLAIM_USER: 'owner' } as Env);
    expect((await signUp(board, authenticator(), 'owner')).statusCode).toBe(200);
    expect((await board.database.withSystem((system) => system.lookupUser('owner')))?.source).toBe(
      'passkey',
    );
  });

  it('[api-033] a registration with a wrong challenge or origin creates nothing', async () => {
    const board = await started();
    const begun = (await signUpOptions(board, 'ada')).json();
    const wrong = await post(board.app, '/api/auth/passkey/signup', {
      flow: begun.flow,
      response: authenticator().register({
        challenge: begun.options.challenge,
        origin: 'http://evil.example',
      }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(await board.database.withSystem((system) => system.lookupUser('ada'))).toBeNull();

    const again = (await signUpOptions(board, 'ada')).json();
    const unverified = await post(board.app, '/api/auth/passkey/signup', {
      flow: again.flow,
      response: authenticator().register({
        challenge: again.options.challenge,
        userVerified: false,
      }),
    });
    expect(unverified.statusCode).toBe(403);
  });

  it('[api-033] a sign-up flow is single use', async () => {
    const board = await started();
    const begun = (await signUpOptions(board, 'ada')).json();
    const device = authenticator();
    const body = {
      flow: begun.flow,
      response: device.register({ challenge: begun.options.challenge }),
    };
    expect((await post(board.app, '/api/auth/passkey/signup', body)).statusCode).toBe(200);
    expect((await post(board.app, '/api/auth/passkey/signup', body)).statusCode).toBe(403);
  });
});

describe('a signed-in user passkeys', () => {
  const addPasskey = async (
    board: PgliteBoard,
    token: string,
    device: SoftwareAuthenticator,
    name: string,
  ) => {
    const begun = (
      await post(board.app, '/api/client/passkeys/register-options', {}, asUser(token))
    ).json();
    return post(
      board.app,
      '/api/client/passkeys/register',
      { flow: begun.flow, response: device.register({ challenge: begun.options.challenge }), name },
      asUser(token),
    );
  };

  const list = async (board: PgliteBoard, token: string) =>
    (
      await board.app.inject({
        url: '/api/client/passkeys/list',
        headers: { ...CONTRACT_HEADERS, cookie: `board-session=${token}` },
      })
    ).json().passkeys as {
      id: string;
      name: string;
      createdAt: string;
      lastUsedAt: string | null;
    }[];

  it('[api-034] a user registers a passkey, which then appears in the list and can sign in', async () => {
    const board = await started();
    const { token } = await registered(board);
    const second = authenticator();
    const answer = await addPasskey(board, token, second, 'Phone');
    expect(answer.statusCode, answer.body).toBe(200);

    const passkeys = await list(board, token);
    expect(passkeys.map((entry) => entry.name)).toEqual(['Passkey', 'Phone']);
    expect(passkeys[1]?.id).toBe(second.credentialId);
    expect(passkeys[1]?.lastUsedAt).toBeNull();

    const { flow, options } = await loginBegin(board);
    expect(
      (await loginWith(board, flow, second.assert({ challenge: options.challenge }))).statusCode,
    ).toBe(200);
    expect((await list(board, token))[1]?.lastUsedAt).not.toBeNull();
  });

  it('[api-034] register-options excludes the passkeys the user already holds', async () => {
    const board = await started();
    const { device, token } = await registered(board);
    const begun = (
      await post(board.app, '/api/client/passkeys/register-options', {}, asUser(token))
    ).json();
    expect(begun.options.excludeCredentials.map((entry: { id: string }) => entry.id)).toEqual([
      device.credentialId,
    ]);
  });

  it('[api-034] registering the same credential twice is a conflict', async () => {
    const board = await started();
    const { device, token } = await registered(board);
    const answer = await addPasskey(board, token, device, 'Again');
    expect(answer.statusCode).toBe(409);
  });

  it('[api-034] a registration needs a name, a live flow of the same user and a verifiable response', async () => {
    const board = await started();
    const { token } = await registered(board);
    const other = await registered(board, 'grace');
    const begun = (
      await post(board.app, '/api/client/passkeys/register-options', {}, asUser(token))
    ).json();
    const device = authenticator();
    const registerWith = (session: string, payload: object) =>
      post(board.app, '/api/client/passkeys/register', payload, asUser(session));

    expect(
      (
        await registerWith(token, {
          flow: begun.flow,
          response: device.register({ challenge: begun.options.challenge }),
          name: '   ',
        })
      ).statusCode,
    ).toBe(400);
    const fresh = (
      await post(board.app, '/api/client/passkeys/register-options', {}, asUser(token))
    ).json();
    expect(
      (
        await registerWith(other.token, {
          flow: fresh.flow,
          response: device.register({ challenge: fresh.options.challenge }),
          name: 'Stolen',
        })
      ).statusCode,
    ).toBe(400);
    const again = (
      await post(board.app, '/api/client/passkeys/register-options', {}, asUser(token))
    ).json();
    expect(
      (
        await registerWith(token, {
          flow: again.flow,
          response: device.register({ challenge: 'AAAA' }),
          name: 'Bad',
        })
      ).statusCode,
    ).toBe(400);
    expect(await list(board, token)).toHaveLength(1);
  });

  it('[api-034] a user renames a passkey and cannot rename one that is not theirs', async () => {
    const board = await started();
    const { device, token } = await registered(board);
    const other = await registered(board, 'grace');
    const rename = (session: string, id: string, name: string) =>
      post(board.app, '/api/client/passkeys/rename', { id, name }, asUser(session));

    expect((await rename(token, device.credentialId, 'Work laptop')).statusCode).toBe(200);
    expect((await list(board, token))[0]?.name).toBe('Work laptop');
    expect((await rename(other.token, device.credentialId, 'Mine')).statusCode).toBe(404);
    expect((await rename(token, 'unknown', 'x')).statusCode).toBe(404);
    expect((await list(board, token))[0]?.name).toBe('Work laptop');
  });

  it('[api-034] a user removes a passkey while another remains, then the last one is refused on a passkey-sourced board', async () => {
    const board = await started();
    const { device, token } = await registered(board);
    const second = authenticator();
    await addPasskey(board, token, second, 'Phone');
    const remove = (id: string) =>
      post(board.app, '/api/client/passkeys/remove', { id }, asUser(token));

    expect((await remove(device.credentialId)).statusCode).toBe(200);
    expect((await remove(device.credentialId)).statusCode).toBe(404);
    const refused = await remove(second.credentialId);
    expect(refused.statusCode).toBe(409);
    expect(await list(board, token)).toHaveLength(1);
  });

  it('[api-034] concurrent removals never leave a passkey-sourced board without a passkey', async () => {
    const board = await started();
    const { device, token } = await registered(board);
    const second = authenticator();
    await addPasskey(board, token, second, 'Phone');
    const answers = await Promise.all(
      [device, second].map((entry) =>
        post(board.app, '/api/client/passkeys/remove', { id: entry.credentialId }, asUser(token)),
      ),
    );
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect(await list(board, token)).toHaveLength(1);
  });

  it('[api-034] the last passkey may go on a board another method created', async () => {
    const board = await started({
      OIDC_ISSUER: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'board',
      OIDC_CLIENT_SECRET: 'secret',
    } as Env);
    await board.database.withOwner('grace', (tx) => ensureUser(tx, 'grace', 'oidc'));
    const token = (await issueSession(board.deps, 'grace', 'cookie', 'oidc')).token;
    const device = authenticator();
    expect((await addPasskey(board, token, device, 'Key')).statusCode).toBe(200);
    const removed = await post(
      board.app,
      '/api/client/passkeys/remove',
      { id: device.credentialId },
      asUser(token),
    );
    expect(removed.statusCode).toBe(200);
    expect(await list(board, token)).toEqual([]);
  });

  it('[api-034] a passkey of another user is neither listed nor removable', async () => {
    const board = await started();
    const ada = await registered(board);
    const grace = await registered(board, 'grace');
    expect(await list(board, grace.token)).toHaveLength(1);
    const removed = await post(
      board.app,
      '/api/client/passkeys/remove',
      { id: ada.device.credentialId },
      asUser(grace.token),
    );
    expect(removed.statusCode).toBe(404);
    expect(await list(board, ada.token)).toHaveLength(1);
  });
});

describe('name ownership by sign-in method', () => {
  const admit = (board: PgliteBoard, owner: string, method: 'passkey' | 'oidc' | 'saml') =>
    board.database.withOwner(owner, (tx) => admitUser(tx, owner, method));

  it('[api-038] a new name is created for the method that asks first', async () => {
    const board = await started();
    expect(await admit(board, 'grace', 'oidc')).toBe('created');
    const user = await board.database.withSystem((system) => system.lookupUser('grace'));
    expect(user?.source).toBe('oidc');
    const projects = await board.database.withOwner('grace', (tx) =>
      tx.select().from(schema.project),
    );
    expect(projects).toHaveLength(1);
  });

  it('[api-038] the owning method is admitted again and another method is refused forbidden', async () => {
    const board = await started();
    await admit(board, 'grace', 'saml');
    expect(await admit(board, 'grace', 'saml')).toBe('existing');
    for (const method of ['oidc', 'passkey'] as const) {
      await expect(admit(board, 'grace', method)).rejects.toMatchObject({ code: 'forbidden' });
    }
    const user = await board.database.withSystem((system) => system.lookupUser('grace'));
    expect(user?.source).toBe('saml');
  });

  it('[api-038] a name with no recorded method is claimed by the first method that asks', async () => {
    const board = await started();
    await board.database.withOwner('owner', (tx) => ensureUser(tx, 'owner', null));
    expect(await admit(board, 'owner', 'oidc')).toBe('existing');
    const user = await board.database.withSystem((system) => system.lookupUser('owner'));
    expect(user?.source).toBe('oidc');
    await expect(admit(board, 'owner', 'saml')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('[api-038] a passkey-created name cannot be taken by another method', async () => {
    const board = await started();
    await registered(board);
    await expect(admit(board, 'ada', 'oidc')).rejects.toMatchObject({ code: 'forbidden' });
    const rows = await board.database.withOwner('ada', (tx) =>
      tx.select().from(schema.appUser).where(eq(schema.appUser.username, 'ada')),
    );
    expect(rows[0]?.source).toBe('passkey');
  });
});
