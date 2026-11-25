import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DATA_HEADERS } from '@agent-board/contract';
import { afterEach, describe, expect, it } from 'vitest';

import { UNKNOWN_VERSION } from '../src/modules/build/index.js';
import { ConfigError, loadConfig, type Env } from '../src/modules/index.js';
import { PART_VERSION } from '../src/version.js';
import {
  CONTRACT_HEADERS,
  JSON_HEADERS,
  MACHINE_TOKEN,
  boot,
  knownMachine,
  loginEnv,
  noLoginEnv,
  type TestBoard,
} from './helpers.js';

const refusal = (env: Env): string => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('the start was not refused');
};

const boards: TestBoard[] = [];
const started = async (env: Env, options?: Parameters<typeof boot>[1]): Promise<TestBoard> => {
  const board = await boot(env, options);
  boards.push(board);
  return board;
};

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.app.close()));
});

describe('health and hosts', () => {
  it('[api-004] GET /healthz answers ok without authentication and ignores allowed hosts', async () => {
    const { app } = await started(loginEnv({ ALLOWED_HOSTS: 'localhost' }));
    const answer = await app.inject({ url: '/healthz', headers: { host: 'elsewhere.example' } });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ status: 'ok' });
  });

  it('[api-014] any Host outside ALLOWED_HOSTS gets 421, even with a spoofed forwarded host', async () => {
    const { app } = await started(noLoginEnv({ ALLOWED_HOSTS: 'board.localhost' }));
    const allowed = await app.inject({
      url: '/api/version',
      headers: { host: 'board.localhost:4000' },
    });
    expect(allowed.statusCode).toBe(200);

    const stranger = await app.inject({ url: '/api/version', headers: { host: 'evil.example' } });
    expect(stranger.statusCode).toBe(421);
    expect(stranger.json().error.code).toBe('misdirected');

    const spoofed = await app.inject({
      url: '/api/version',
      headers: { host: 'evil.example', 'x-forwarded-host': 'board.localhost' },
    });
    expect(spoofed.statusCode).toBe(421);

    const unknownPath = await app.inject({ url: '/nowhere', headers: { host: 'evil.example' } });
    expect(unknownPath.statusCode).toBe(421);
  });

  it('[api-014] without ALLOWED_HOSTS every Host is served', async () => {
    const { app } = await started(noLoginEnv());
    const answer = await app.inject({ url: '/api/version', headers: { host: 'anything.example' } });
    expect(answer.statusCode).toBe(200);
  });
});

describe('authentication mode', () => {
  it('[api-005] refuses a start with neither no-login user nor public URL', () => {
    expect(refusal({ DATABASE_URL: 'pglite:///tmp/x' })).toMatch(/NO_LOGIN_USER[\s\S]*PUBLIC_URL/);
  });

  it('[api-005] refuses no-login next to each login-only setting', () => {
    for (const [name, value] of [
      ['PUBLIC_URL', 'http://localhost:4000'],
      ['PASSKEYS', 'on'],
      ['SIGNUP_TOKEN', 'x'.repeat(40)],
      ['ALLOWED_GROUPS', 'admins'],
      ['OIDC_ISSUER', 'https://idp.example'],
      ['SAML_IDP_METADATA_URL', 'https://idp.example/metadata'],
      ['SESSION_DAYS', '7'],
    ] as const) {
      expect(refusal(noLoginEnv({ [name]: value })), name).toContain(name);
    }
  });

  it('[api-005] refuses the user name of the other mode and an unknown AUTH_MODE', () => {
    expect(refusal(loginEnv({ NO_LOGIN_USER: 'owner' }))).toContain('NO_LOGIN_USER');
    expect(refusal(noLoginEnv({ AUTH_MODE: 'login' }))).toContain('NO_LOGIN_USER');
    expect(refusal(noLoginEnv({ AUTH_MODE: 'both' }))).toContain('AUTH_MODE');
    expect(refusal({ DATABASE_URL: 'pglite:///tmp/x', AUTH_MODE: 'no-login' })).toContain(
      'NO_LOGIN_USER',
    );
  });

  it('[api-005] starts in exactly one mode, inferred or explicit', () => {
    expect(loadConfig(noLoginEnv()).signIn.mode).toBe('no-login');
    expect(loadConfig(noLoginEnv({ AUTH_MODE: 'no-login' })).signIn.mode).toBe('no-login');
    expect(loadConfig(loginEnv()).signIn.mode).toBe('login');
    expect(
      loadConfig({ DATABASE_URL: 'pglite:///tmp/x', PUBLIC_URL: 'http://localhost:4000' }).signIn
        .mode,
    ).toBe('login');
  });

  it('[api-006] the public URL is a bare origin and its hostname is the relying-party id', () => {
    const config = loadConfig(loginEnv({ PUBLIC_URL: 'https://Board.Example.com' }));
    expect(config.signIn).toMatchObject({
      publicUrl: 'https://board.example.com',
      rpId: 'board.example.com',
      scheme: 'https',
    });
    for (const bad of [
      'https://board.example.com/app',
      'https://board.example.com/?x=1',
      'https://user:pass@board.example.com',
      'board.example.com',
    ]) {
      expect(refusal(loginEnv({ PUBLIC_URL: bad })), bad).toContain('PUBLIC_URL');
    }
  });

  it('[api-006] production demands https', () => {
    expect(refusal(loginEnv({ NODE_ENV: 'production' }))).toMatch(
      /PUBLIC_URL: must be an https URL/,
    );
    expect(
      loadConfig(loginEnv({ NODE_ENV: 'production', PUBLIC_URL: 'https://b.example.com' })).signIn
        .mode,
    ).toBe('login');
  });

  it('[api-007] refuses allowed groups without OIDC', () => {
    expect(refusal(loginEnv({ ALLOWED_GROUPS: 'admins' }))).toContain('ALLOWED_GROUPS');
    expect(
      loadConfig(
        loginEnv({
          ALLOWED_GROUPS: 'admins',
          OIDC_ISSUER: 'https://idp.example',
          OIDC_CLIENT_ID: 'board',
          OIDC_CLIENT_SECRET: 'secret',
        }),
      ).signIn,
    ).toMatchObject({
      allowedGroups: ['admins'],
      oidc: { issuer: 'https://idp.example', clientId: 'board' },
    });
  });

  it('[api-007] refuses a sign-up token under 32 characters and one next to passkeys off', () => {
    expect(refusal(loginEnv({ SIGNUP_TOKEN: 'short' }))).toContain(
      'SIGNUP_TOKEN: must be at least 32',
    );
    expect(
      refusal(
        loginEnv({
          SIGNUP_TOKEN: 'x'.repeat(32),
          PASSKEYS: 'off',
          OIDC_ISSUER: 'https://idp.example',
          OIDC_CLIENT_ID: 'board',
          OIDC_CLIENT_SECRET: 'secret',
        }),
      ),
    ).toContain('SIGNUP_TOKEN: needs PASSKEYS=on');
    expect(loadConfig(loginEnv({ SIGNUP_TOKEN: 'x'.repeat(32) })).signIn).toMatchObject({
      signupToken: 'x'.repeat(32),
    });
  });

  it('[api-007] refuses login mode with no method enabled', () => {
    expect(refusal(loginEnv({ PASSKEYS: 'off' }))).toContain('no way to sign in');
    expect(
      loadConfig(
        loginEnv({ PASSKEYS: 'off', SAML_IDP_METADATA_URL: 'https://idp.example/metadata' }),
      ).signIn,
    ).toMatchObject({ passkeys: false, saml: { metadataUrl: 'https://idp.example/metadata' } });
  });

  it('[api-007] a secret never appears in a refusal message', () => {
    const secret = 'sssshhh-sssshhh-';
    expect(refusal(loginEnv({ SIGNUP_TOKEN: secret }))).not.toContain(secret);
  });
});

describe('build identity', () => {
  it('[api-008] a malformed build version is reported as unknown, never a start error', () => {
    expect(loadConfig(noLoginEnv({ BUILD_VERSION: 'banana' })).build.version).toBe(UNKNOWN_VERSION);
    expect(loadConfig(noLoginEnv({ BUILD_VERSION: '2.4.6' })).build.version).toBe('2.4.6');
    expect(loadConfig(noLoginEnv()).build.version).toBe(PART_VERSION);
  });

  it('[api-008] a malformed commit is reported as null, a well-formed one is lower-cased', () => {
    expect(loadConfig(noLoginEnv({ GIT_SHA: 'not a sha' })).build.commit).toBeNull();
    expect(loadConfig(noLoginEnv({ GIT_SHA: 'ABCDEF1234' })).build.commit).toBe('abcdef1234');
    expect(loadConfig(noLoginEnv()).build.commit).toBeNull();
  });
});

describe('shutdown', () => {
  it('[api-010] closing ends open event streams and closes the database once', async () => {
    const board = await boot(noLoginEnv());
    let ended = 0;
    board.streams.add(() => {
      ended += 1;
    });
    board.streams.add(() => {
      ended += 1;
    });
    await board.app.close();
    expect(ended).toBe(2);
    expect(board.closed.database).toBe(1);
  });
});

describe('API errors', () => {
  it('[api-011] a non-GET API request without a JSON content type gets 415', async () => {
    const { app } = await started(noLoginEnv());
    for (const headers of [
      {},
      { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' },
    ]) {
      const answer = await app.inject({
        method: 'POST',
        url: '/api/client/revision',
        headers,
        payload: '{}',
      });
      expect(answer.statusCode, JSON.stringify(headers)).toBe(415);
      expect(answer.json().error.code).toBe('unsupported-media-type');
    }
  });

  it('[api-011] a percent-encoded API path still needs a JSON content type', async () => {
    const { app } = await started(noLoginEnv());
    const answer = await app.inject({
      method: 'POST',
      url: '/%61pi/auth/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...CONTRACT_HEADERS },
      payload: '',
    });
    expect(answer.statusCode).toBe(415);
  });

  it('[api-012] a body to an unknown path is refused past the public body limit', async () => {
    const { app } = await started(noLoginEnv());
    const answer = await app.inject({
      method: 'POST',
      url: '/nowhere',
      headers: JSON_HEADERS,
      payload: ' '.repeat(128 * 1024),
    });
    expect(answer.statusCode).toBe(413);
  });

  it('[api-011] a JSON content type with a charset passes and a GET needs none', async () => {
    const { app } = await started(noLoginEnv());
    const posted = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'content-type': 'application/json; charset=utf-8', ...CONTRACT_HEADERS },
      payload: '{}',
    });
    expect(posted.statusCode).toBe(200);
    const read = await app.inject({ url: '/healthz' });
    expect(read.statusCode).toBe(200);
  });

  it('[api-012] errors are JSON {error:{code,message}} with the status the contract gives the code', async () => {
    const { app } = await started(noLoginEnv());
    const missing = await app.inject({ url: '/api/nothing-here' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not-found', message: 'not found' } });

    const wrongMethod = await app.inject({
      method: 'POST',
      url: '/healthz',
      headers: JSON_HEADERS,
      payload: '{}',
    });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.json().error.code).toBe('method-not-allowed');
    expect(wrongMethod.headers.allow).toContain('GET');

    const headers = { ...JSON_HEADERS, ...CONTRACT_HEADERS };
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers,
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('bad-request');

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers,
      payload: '{"extra":1}',
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().error.code).toBe('bad-request');

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers,
      payload: ' '.repeat(3 * 1024 * 1024),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('payload-too-large');
  });

  it('[api-012] any other 5xx reads "internal error" and leaks nothing', async () => {
    const { app } = await started(noLoginEnv(), { credentials: knownMachine });
    const answer = await app.inject({
      method: 'POST',
      url: '/api/machine/version',
      headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${MACHINE_TOKEN}` },
      payload: '{}',
    });
    expect(answer.statusCode).toBe(500);
    expect(answer.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
    expect(answer.body).not.toContain('boom');
  });

  it('[api-012] a route no build has implemented yet answers unavailable (503)', async () => {
    const { app } = await started(noLoginEnv(), { handlers: [] });
    const answer = await app.inject({ url: '/api/client/revision', headers: CONTRACT_HEADERS });
    expect(answer.statusCode).toBe(503);
    expect(answer.json().error.code).toBe('unavailable');
  });
});

describe('listen', () => {
  it('[api-013] the default host is unset (loopback in no-login, every interface in login mode)', () => {
    expect(loadConfig(noLoginEnv()).listen.host).toBeNull();
    expect(loadConfig(loginEnv()).listen.host).toBeNull();
    expect(loadConfig(noLoginEnv({ HOST: '127.0.0.1', PORT: '0' })).listen).toMatchObject({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('[api-013] HOST and PORT are read, and a bad PORT is refused', () => {
    expect(loadConfig(loginEnv({ HOST: '10.0.0.5', PORT: '8080' })).listen).toMatchObject({
      host: '10.0.0.5',
      port: 8080,
    });
    expect(refusal(noLoginEnv({ PORT: '70000' }))).toContain('PORT');
    expect(refusal(noLoginEnv({ PORT: 'abc' }))).toContain('PORT');
  });

  it('[api-013] ALLOWED_HOSTS lists names without a port', () => {
    expect(
      loadConfig(noLoginEnv({ ALLOWED_HOSTS: 'Localhost, 127.0.0.1' })).listen.allowedHosts,
    ).toEqual(['localhost', '127.0.0.1']);
    expect(refusal(noLoginEnv({ ALLOWED_HOSTS: 'localhost:4000' }))).toContain('ALLOWED_HOSTS');
  });
});

describe('modules', () => {
  it('[api-021] each concern is a module switched by configuration', () => {
    const config = loadConfig(
      loginEnv({
        REQUEST_SIGNATURE: 'on',
        EVENTS_DRIVER: 'memory',
        SCHEDULING: 'off',
        FEEDS: 'off',
        ALLOWED_ORIGINS: 'https://app.example.com, tauri://localhost',
        ALLOWED_HOSTS: 'localhost',
      }),
    );
    expect(config).toMatchObject({
      requestSignature: true,
      events: 'memory',
      scheduling: false,
      feeds: false,
      crossOrigin: ['https://app.example.com', 'tauri://localhost'],
      database: { kind: 'pglite' },
    });
    expect(loadConfig(noLoginEnv()).scheduling).toBe(true);
    expect(loadConfig(noLoginEnv()).requestSignature).toBe(false);
  });

  it('[api-021] an invalid value or combination refuses the start naming the variable', () => {
    expect(refusal(noLoginEnv({ REQUEST_SIGNATURE: 'maybe' }))).toContain(
      'REQUEST_SIGNATURE: must be "on" or "off"',
    );
    expect(refusal(noLoginEnv({ SCHEDULING: 'x' }))).toContain('SCHEDULING');
    expect(refusal(noLoginEnv({ FEEDS: 'x' }))).toContain('FEEDS');
    expect(refusal(noLoginEnv({ EVENTS_DRIVER: 'kafka' }))).toContain('EVENTS_DRIVER');
    expect(refusal(noLoginEnv({ ALLOWED_ORIGINS: 'not an origin' }))).toContain('ALLOWED_ORIGINS');
    expect(refusal(noLoginEnv({ WEB_ROOT: '/definitely/not/here' }))).toContain('WEB_ROOT');
    expect(refusal(noLoginEnv({ EVENTS_DRIVER: 'postgres' }))).toContain(
      'EVENTS_DRIVER: postgres needs a postgres://',
    );
    expect(refusal({ NO_LOGIN_USER: 'owner' })).toContain('DATABASE_URL: is required');
    expect(refusal(noLoginEnv({ DATABASE_URL: 'mysql://x' }))).toContain('DATABASE_URL');
    expect(refusal(noLoginEnv({ DATABASE_ADMIN_URL: 'postgres://a/b' }))).toContain(
      'DATABASE_ADMIN_URL',
    );
  });

  it('[api-021] Postgres with its admin URL and the postgres events driver start', () => {
    const config = loadConfig(
      noLoginEnv({
        DATABASE_URL: 'postgres://board_app:pw@localhost:5432/board',
        DATABASE_ADMIN_URL: 'postgres://admin:pw@localhost:5432/board',
        EVENTS_DRIVER: 'postgres',
      }),
    );
    expect(config.database).toEqual({
      kind: 'postgres',
      url: 'postgres://board_app:pw@localhost:5432/board',
      adminUrl: 'postgres://admin:pw@localhost:5432/board',
    });
    expect(config.events).toBe('postgres');
  });

  it('[api-021] reports every problem at once', () => {
    const message = refusal({ AUTH_MODE: 'login', REQUEST_SIGNATURE: 'x', FEEDS: 'y' });
    expect(message).toContain('PUBLIC_URL');
    expect(message).toContain('REQUEST_SIGNATURE');
    expect(message).toContain('FEEDS');
    expect(message).toContain('DATABASE_URL');
  });

  it('[api-021] a switched-off module answers not-enabled on its routes', async () => {
    const { app } = await started(noLoginEnv({ SCHEDULING: 'off', FEEDS: 'off' }), {
      handlers: [],
    });
    const schedules = await app.inject({
      url: '/api/client/schedules/list',
      headers: CONTRACT_HEADERS,
    });
    expect(schedules.statusCode).toBe(404);
    expect(schedules.json().error.code).toBe('not-enabled');
    const feeds = await app.inject({ url: '/api/client/feeds/list', headers: CONTRACT_HEADERS });
    expect(feeds.json().error.code).toBe('not-enabled');
    const version = await app.inject({ url: '/api/version' });
    expect(version.json().modules).toMatchObject({ scheduling: false, feeds: false });
    expect(version.json().features).not.toContain('schedules');
    expect(version.json().features).not.toContain('feeds');
  });
});

describe('header table', () => {
  const expectTable = (headers: Record<string, unknown>): void => {
    for (const [name, value] of Object.entries(DATA_HEADERS)) {
      if (name === 'content-type') expect(String(headers[name])).toContain('application/json');
      else expect(headers[name], name).toBe(value);
    }
  };

  it('[api-110] every answer carries the contract header table: success, refusal and 5xx', async () => {
    const { app } = await started(noLoginEnv());
    const machine = await started(noLoginEnv(), { credentials: knownMachine });
    const answers = [
      await app.inject({ url: '/healthz' }),
      await app.inject({ url: '/api/version' }),
      await app.inject({ url: '/api/nothing' }),
      await app.inject({ method: 'POST', url: '/api/client/me', payload: '{}' }),
      await app.inject({ url: '/api/client/revision' }),
      await machine.app.inject({
        method: 'POST',
        url: '/api/machine/version',
        headers: { ...JSON_HEADERS, ...CONTRACT_HEADERS, authorization: `Bearer ${MACHINE_TOKEN}` },
        payload: '{}',
      }),
    ];
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 404, 415, 412, 500]);
    for (const answer of answers) expectTable(answer.headers);
  });

  it('[api-110] https login boards add the HSTS header, http boards do not', async () => {
    const secure = await started(loginEnv({ PUBLIC_URL: 'https://board.example.com' }));
    const plain = await started(noLoginEnv());
    const secured = await secure.app.inject({ url: '/healthz' });
    expect(secured.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    const unsecured = await plain.app.inject({ url: '/healthz' });
    expect(unsecured.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('access log', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  const logFile = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'board-access-'));
    folders.push(folder);
    return join(folder, 'access.log');
  };

  it('[api-112] with ACCESS_LOG set one line per request holds method, path without query and status', async () => {
    const file = logFile();
    const { app } = await started(noLoginEnv({ ACCESS_LOG: file }));
    await app.inject({ url: '/healthz?probe=1' });
    await app.inject({ method: 'POST', url: '/api/client/me', payload: '{}' });
    await app.inject({ url: '/missing' });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual([
      'GET /healthz 200',
      'POST /api/client/me 415',
      'GET /missing 404',
    ]);
  });

  it('[api-112] appends to an existing file and logs nothing without the setting', async () => {
    const file = logFile();
    const first = await boot(noLoginEnv({ ACCESS_LOG: file }));
    await first.app.inject({ url: '/healthz' });
    await first.app.close();
    const second = await boot(noLoginEnv({ ACCESS_LOG: file }));
    await second.app.inject({ url: '/healthz' });
    await second.app.close();
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(loadConfig(noLoginEnv()).accessLog).toBeNull();
  });
});

describe('request signature and exposure', () => {
  it('[api-121] no-login with a non-loopback HOST or allowed host refuses to start unless the signature is on', () => {
    expect(refusal(noLoginEnv({ HOST: '0.0.0.0' }))).toContain('REQUEST_SIGNATURE');
    expect(refusal(noLoginEnv({ HOST: '192.168.1.10' }))).toContain('REQUEST_SIGNATURE');
    expect(refusal(noLoginEnv({ ALLOWED_HOSTS: 'board.example.com' }))).toContain(
      'ALLOWED_HOSTS board.example.com',
    );
    expect(refusal(noLoginEnv({ ALLOWED_HOSTS: 'localhost,tunnel.example.net' }))).toContain(
      'ALLOWED_HOSTS tunnel.example.net',
    );
  });

  it('[api-121] loopback names and the signature switch let it start', () => {
    for (const env of [
      noLoginEnv(),
      noLoginEnv({ HOST: '127.0.0.1' }),
      noLoginEnv({ HOST: 'localhost', ALLOWED_HOSTS: 'localhost,127.0.0.1' }),
      noLoginEnv({ HOST: '::1' }),
      noLoginEnv({ HOST: '0.0.0.0', REQUEST_SIGNATURE: 'on' }),
      noLoginEnv({ ALLOWED_HOSTS: 'board.example.com', REQUEST_SIGNATURE: 'on' }),
    ]) {
      expect(() => loadConfig(env)).not.toThrow();
    }
  });

  it('[api-121] login mode is not subject to the rule', () => {
    expect(() =>
      loadConfig(loginEnv({ HOST: '0.0.0.0', ALLOWED_HOSTS: 'board.example.com' })),
    ).not.toThrow();
  });
});
