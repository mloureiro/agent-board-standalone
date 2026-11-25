import { sessionCookieName } from '@agent-board/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  callOk,
  clientToken,
  cookieSession,
  type ServerRef,
} from '../src/client/contract-client.js';
import { flattenStrings, inspectDatabase } from '../src/fixtures/db-inspect.js';
import { unlockedKey } from '../src/fixtures/keys.js';
import type { LoginBoard } from '../src/fixtures/login-board.js';
import { createTask } from '../src/fixtures/tasks.js';
import {
  handoffToken,
  noLoginUser,
  pkcePair,
  signedInUser,
  type BoardUser,
} from '../src/fixtures/users.js';
import { setClockOffset } from '../src/harness/clock.js';
import { recordSkip } from '../src/harness/skip.js';
import { useBoard } from '../src/harness/vitest.js';
import {
  CLIENT_TOKEN_PATTERN,
  DAY_SECONDS,
  HANDOFF_CODE_PATTERN,
  HANDOFF_EXPIRY_SECONDS,
  SESSION_TOKEN_PATTERN,
  finishHandoff,
  grantsNoSession,
  openSignInBoard,
  startHandoff,
} from '../src/steps/sign-in.js';

const NO_LOGIN_OWNER = 'e2e-owner';
const SESSION_DAYS = 30;

describe('no-login mode', () => {
  const harness = useBoard({
    parts: ['api'],
    features: [],
    auth: 'no-login',
    env: { NO_LOGIN_USER: NO_LOGIN_OWNER },
  });

  it('[api-029] a client read with no credential is the configured user', async () => {
    const server: ServerRef = { url: harness.board.url };
    const me = await callOk(server, 'client.me', {});
    expect(me.username).toBe(NO_LOGIN_OWNER);
    const listed = await call(server, 'client.tasks.list', {});
    expect(listed.ok).toBe(true);
  });
});

describe('no-login mode with the database inspected', () => {
  const harness = useBoard({
    parts: ['api', 'postgres'],
    features: [],
    auth: 'no-login',
    env: { NO_LOGIN_USER: NO_LOGIN_OWNER },
  });

  it('[api-029] the user row does not exist after reads only and exists after one committed write', async () => {
    const { board } = harness;
    const server: ServerRef = { url: board.url };
    await callOk(server, 'client.me', {});
    await callOk(server, 'client.tasks.list', {});

    const inspector = await inspectDatabase(board.database);
    try {
      const tables = await inspector.tables();
      const userTable = tables.find((name) => /^users?$/.test(name));
      expect(userTable, `no user table among ${tables.join(', ')}`).toBeDefined();
      const holdsOwner = async (): Promise<boolean> =>
        (await inspector.rows(userTable as string)).some((row) =>
          flattenStrings(Object.values(row)).includes(NO_LOGIN_OWNER),
        );

      expect(await holdsOwner()).toBe(false);

      const user = await noLoginUser(server);
      const key = await unlockedKey(board, user);
      await createTask(board, user, key, { prompt: 'first committed write', status: 'backlog' });

      expect(await holdsOwner()).toBe(true);
    } finally {
      await inspector.close();
    }
  });
});

describe('login mode', () => {
  const options = { oidc: true } as const;
  let board: LoginBoard | null = null;
  let reason: string | null = null;

  beforeAll(async () => {
    const opened = await openSignInBoard({
      parts: ['api'],
      features: ['client-tokens'],
      options,
    });
    board = opened.board;
    reason = opened.reason;
  }, 120_000);

  afterAll(async () => {
    await board?.stop();
  });

  beforeEach((context) => {
    if (reason === null) return;
    const titles = [context.task.name];
    for (let suite = context.task.suite; suite; suite = suite.suite) {
      if (suite.type === 'suite' && suite.name) titles.unshift(suite.name);
    }
    recordSkip({
      file: context.task.file.filepath,
      titlePath: titles,
      project: 'blackbox',
      reason,
    });
    context.skip(reason);
  });

  afterEach(() => {
    if (board !== null) setClockOffset(board, 0);
  });

  const live = (): LoginBoard => {
    if (board === null) throw new Error('the board is not started');
    return board;
  };

  const clientTokenUser = async (approver: BoardUser): Promise<BoardUser> =>
    signedInUser(live(), { tokenKind: 'client', approver });

  describe('hand-off', () => {
    it('[api-039] a public start returns an XXXX-XXXX code and a flow id that a signed-in user can read back', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      expect(started.code).toMatch(HANDOFF_CODE_PATTERN);
      expect(started.flow.length).toBeGreaterThan(0);
      const described = await approver.ok('auth.handoff.describe', { flow: started.flow });
      expect(described.code).toBe(started.code);
    });

    it('[api-039] a finish before approval grants no session', async () => {
      const started = await startHandoff(live());
      const finished = await finishHandoff(live(), started);
      expect(grantsNoSession(finished)).toBe(true);
      expect(finished.jar.names()).toEqual([]);
    });

    it('[api-039] a finish with a wrong verifier is refused and the flow stays usable', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      await approver.ok('auth.handoff.approve', { flow: started.flow });

      const wrong = await finishHandoff(live(), {
        flow: started.flow,
        verifier: pkcePair().verifier,
      });
      expect(wrong.result.ok).toBe(false);
      expect(wrong.result.error?.code).toBe('forbidden');
      expect(wrong.setCookies).toEqual([]);

      const right = await finishHandoff(live(), started);
      expect(right.result.ok).toBe(true);
      expect(right.result.body).toMatchObject({ status: 'signed-in' });
    });

    it('[api-039] a finish with the right verifier creates the session once', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      await approver.ok('auth.handoff.approve', { flow: started.flow });

      const first = await finishHandoff(live(), started);
      expect(first.result.ok).toBe(true);
      expect(first.result.body).toMatchObject({ status: 'signed-in' });
      expect(first.jar.get(sessionCookieName('http'))).toMatch(SESSION_TOKEN_PATTERN);
      const me = await call(live(), 'client.me', {}, cookieSession(first.jar));
      expect(me.body?.username).toBe(approver.username);

      const second = await finishHandoff(live(), started);
      expect(second.result.ok).toBe(false);
      expect(second.setCookies).toEqual([]);
    });

    it('[api-039] a flow approved at 9 minutes still finishes', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      setClockOffset(live(), HANDOFF_EXPIRY_SECONDS - 60);
      const approved = await approver.call('auth.handoff.approve', { flow: started.flow });
      expect(approved.ok).toBe(true);
      const finished = await finishHandoff(live(), started);
      expect(finished.result.ok).toBe(true);
      expect(finished.result.body).toMatchObject({ status: 'signed-in' });
    });

    it('[api-039] an unapproved flow is refused after 10 minutes', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      setClockOffset(live(), HANDOFF_EXPIRY_SECONDS + 1);
      const approved = await approver.call('auth.handoff.approve', { flow: started.flow });
      expect(approved.ok).toBe(false);
      const finished = await finishHandoff(live(), started);
      expect(finished.result.ok).toBe(false);
      expect(finished.setCookies).toEqual([]);
    });

    it('[api-039] [api-114] a finish asking for tokenKind client returns an abc_ token in the body and sets no cookie', async () => {
      const approver = await signedInUser(live());
      const started = await startHandoff(live());
      await approver.ok('auth.handoff.approve', { flow: started.flow });

      const finished = await finishHandoff(live(), { ...started, tokenKind: 'client' });
      expect(finished.result.ok).toBe(true);
      expect(finished.result.body).toMatchObject({ status: 'signed-in' });
      const token =
        finished.result.body?.status === 'signed-in' ? finished.result.body.token : null;
      expect(token).toMatch(new RegExp(`^${CLIENT_TOKEN_PATTERN.source}$`));
      expect(finished.setCookies).toEqual([]);
      expect(finished.jar.names()).toEqual([]);
    });
  });

  describe('client token', () => {
    it('[api-114] an abc_ token works as Authorization Bearer', async () => {
      const approver = await signedInUser(live());
      const user = await clientTokenUser(approver);
      expect(user.credential).toMatchObject({ kind: 'client' });
      const me = await user.ok('client.me', {});
      expect(me.username).toBe(approver.username);
    });

    it('[api-114] an abs_ session value sent as Authorization Bearer is refused', async () => {
      const approver = await signedInUser(live());
      const value = approver.sessionCookie()?.value;
      expect(value).toMatch(SESSION_TOKEN_PATTERN);
      const refused = await call(live(), 'client.me', {}, clientToken(value as string));
      expect(refused.status).toBe(401);
      expect(refused.error?.code).toBe('unauthorized');
    });

    it('[api-114] a token expires 30 days after last use and a use slides the expiry', async () => {
      const approver = await signedInUser(live());
      const used = await handoffToken(live(), approver);
      const idle = await handoffToken(live(), approver);

      setClockOffset(live(), (SESSION_DAYS - 1) * DAY_SECONDS);
      expect((await call(live(), 'client.me', {}, clientToken(used))).ok).toBe(true);

      setClockOffset(live(), (SESSION_DAYS + 1) * DAY_SECONDS);
      expect((await call(live(), 'client.me', {}, clientToken(used))).ok).toBe(true);

      const expired = await call(live(), 'client.me', {}, clientToken(idle));
      expect(expired.status).toBe(401);
      expect(expired.error?.code).toBe('unauthorized');
    });

    it('[api-114] logout with the token deletes only that session', async () => {
      const approver = await signedInUser(live());
      const user = await clientTokenUser(approver);
      const other = await clientTokenUser(approver);

      const loggedOut = await user.call('auth.logout', {});
      expect(loggedOut.ok).toBe(true);

      const refused = await user.call('client.me', {});
      expect(refused.status).toBe(401);
      expect((await other.call('client.me', {})).ok).toBe(true);
      expect((await approver.call('client.me', {})).ok).toBe(true);
    });
  });
});
