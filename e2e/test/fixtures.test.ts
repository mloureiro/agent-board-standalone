import path from 'node:path';

import { bindings, decodeDataKey, deriveKeys, unwrapSlot } from '@rumo/sealing';
import { TOKEN_PATTERN } from '@rumo/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { anonymous, call, clientToken, type ServerRef } from '../src/client/contract-client.js';
import { DEFAULT_PASSPHRASE, dataKeyBytes, unlockedKey } from '../src/fixtures/keys.js';
import {
  launchDatabaseKind,
  postgresAllowedIn,
  retryOnPortRace,
  startBoardPair,
} from '../src/fixtures/boards.js';
import { startLoginBoard } from '../src/fixtures/login-board.js';
import { enrolledMachine } from '../src/fixtures/machines.js';
import { createTask } from '../src/fixtures/tasks.js';
import { handoffToken, noLoginUser, pkcePair, type BoardUser } from '../src/fixtures/users.js';
import { startApi, type ApiHandle } from '../src/harness/api.js';
import { createPgliteDatabase } from '../src/harness/database.js';
import { retryOnBindRace } from '../src/harness/ports.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { createTmp, type Tmp } from '../src/harness/tmp.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');
const fakeCli = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-cli.ts');
const originalApi = process.env.RUMO_API_BIN;
const originalCli = process.env.RUMO_CLI_BIN;

let api: ApiHandle;
let tmp: Tmp;
let server: ServerRef;

beforeAll(async () => {
  process.env.RUMO_API_BIN = fakeApi;
  process.env.RUMO_CLI_BIN = fakeCli;
  tmp = createTmp('fixtures');
  api = await startApi({ tmp, database: createPgliteDatabase(tmp), auth: 'no-login' });
  server = { url: api.url };
});

afterAll(async () => {
  await api.stop();
  tmp.remove();
  for (const [name, value] of [
    ['RUMO_API_BIN', originalApi],
    ['RUMO_CLI_BIN', originalCli],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface Recorded {
  name: string;
  input: Record<string, unknown>;
}

function recordingUser(answers: Record<string, unknown> = {}): {
  user: BoardUser;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const user = {
    kind: 'no-login',
    owner: 'owner-1',
    username: 'owner-1',
    server,
    credential: anonymous,
    signer: null,
    ok: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      return answers[name] ?? { task: null };
    },
  } as unknown as BoardUser;
  return { user, calls };
}

describe('noLoginUser', () => {
  it('reads who the board says it is and calls routes with no credential', async () => {
    const user = await noLoginUser(server);
    expect(user.kind).toBe('no-login');
    expect(user.username).toBe('tester');
    expect(user.owner).toBe('tester');
    expect(user.sessionCookie()).toBeNull();
    expect(await user.ok('client.me', {})).toEqual({ username: 'tester', keyId: null });
    const missing = await user.call('client.tasks.get', { id: 'x' });
    expect(missing.status).toBe(404);
  });

  it('streams events as the user', async () => {
    const user = await noLoginUser(server);
    const stream = await user.events();
    expect((await stream.nextEvent()).event).toBe('tasks');
    stream.close();
    await stream.closed;
  });
});

describe('unlockedKey', () => {
  it('creates a passphrase and a recovery slot around one data key and stores them', async () => {
    const { user, calls } = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, user, DEFAULT_PASSPHRASE);
    const setup = calls.find((entry) => entry.name === 'client.keys.setup')?.input as {
      keyId: string;
      slots: Parameters<typeof unwrapSlot>[0];
    };
    expect(setup.keyId).toBe(key.keyId);
    expect(key.dataKey).toMatch(/^abk1_/);
    expect(setup.slots.map((slot) => slot.kind)).toEqual(['passphrase', 'recovery']);

    const viaPassphrase = await unwrapSlot(setup.slots, {
      kind: 'passphrase',
      passphrase: DEFAULT_PASSPHRASE,
    });
    const viaRecovery = await unwrapSlot(setup.slots, {
      kind: 'recovery',
      recoveryKey: key.recoveryKey as string,
    });
    expect(Buffer.from(viaPassphrase)).toEqual(Buffer.from(dataKeyBytes(key)));
    expect(Buffer.from(viaRecovery)).toEqual(Buffer.from(decodeDataKey(key.dataKey)));
    expect((await deriveKeys(viaPassphrase, 'owner-1')).keyId).toBe(key.keyId);
  });

  it('seals and opens with bindings and finds the same key again from the stored setup', async () => {
    const first = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, first.user, 'another passphrase 1');
    const stored = first.calls.find((entry) => entry.name === 'client.keys.setup')?.input;
    const binding = bindings.title({ task: 't-1' });
    const sealed = await key.seal(binding, 'hello');
    expect(sealed.startsWith('abe1.')).toBe(true);
    expect(await key.open(binding, sealed)).toBe('hello');
    await expect(key.open(bindings.title({ task: 't-2' }), sealed)).rejects.toThrow();

    const second = recordingUser({ 'client.keys.get': { setup: stored } });
    const again = await unlockedKey(server, second.user, 'another passphrase 1');
    expect(again.dataKey).toBe(key.dataKey);
    expect(second.calls.some((entry) => entry.name === 'client.keys.setup')).toBe(false);
    expect(await again.open(binding, sealed)).toBe('hello');
    await expect(unlockedKey(server, second.user, 'a wrong passphrase 12')).rejects.toThrow();
  });
});

describe('createTask', () => {
  it('seals the title and prompt under the task bindings and maps the status', async () => {
    const keyCalls = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, keyCalls.user, DEFAULT_PASSPHRASE);
    const { user, calls } = recordingUser();
    const task = await createTask(server, user, key, {
      prompt: 'Fix the build\nand the tests',
      project: '5b0f8b2e-6c0a-4d6b-9e75-0c6d9c5f6d11',
      status: 'backlog',
    });
    const sent = calls[0]?.input as { id: string; title: string; input: string; when: string };
    expect(calls[0]?.name).toBe('client.tasks.create');
    expect(sent.when).toBe('backlog');
    expect(task.title).toBe('Fix the build');
    expect(await key.open(bindings.title({ task: task.id }), sent.title)).toBe('Fix the build');
    expect(
      await key.open(bindings.input({ origin: { task: task.id }, creator: 'user' }), sent.input),
    ).toBe('Fix the build\nand the tests');
    expect(sent).toMatchObject({ projectId: '5b0f8b2e-6c0a-4d6b-9e75-0c6d9c5f6d11' });
  });
});

describe('hand-off', () => {
  it('has the approver approve the flow and returns the client token', async () => {
    const { user, calls } = recordingUser();
    const token = await handoffToken(server, user);
    expect(token).toMatch(TOKEN_PATTERN);
    expect(calls).toEqual([{ name: 'auth.handoff.approve', input: { flow: 'flow-1' } }]);
    expect((await call(server, 'client.me', {}, clientToken(token))).ok).toBe(true);
  });

  it('makes PKCE pairs the contract accepts', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{32,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('enrolledMachine', () => {
  it('issues a token, writes 600 secret files and runs rumo init under its own root', async () => {
    const user = await noLoginUser(server);
    const keyCalls = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, keyCalls.user, DEFAULT_PASSPHRASE);
    const board = { url: server.url, tmp };
    const first = await enrolledMachine(board, user, { key, name: 'alpha' });
    const second = await enrolledMachine(board, user, { key, name: 'beta' });

    expect(first.token).toMatch(TOKEN_PATTERN);
    expect(first.credential).toEqual({ kind: 'machine', token: first.token });
    expect(first.tmp.root).not.toBe(second.tmp.root);
    expect(first.tmp.clockFile).toBe(tmp.clockFile);

    const init = await first.cli([
      'init',
      '--probe',
      '--token-file',
      first.tokenFile,
      '--data-key-file',
      first.dataKeyFile,
    ]);
    const probe = JSON.parse(init.stdout) as {
      token: { mode: string; content: string };
      dataKey: { mode: string; content: string };
      env: Record<string, string>;
    };
    expect(probe.token).toEqual({ mode: '600', content: first.token });
    expect(probe.dataKey).toEqual({ mode: '600', content: key.dataKey });
    expect(probe.env.RUMO_CONFIG_DIR).toBe(first.tmp.path('cli', 'config'));
    expect(probe.env.RUMO_WORKER_SPAWN).toBe('process');
    expect(probe.env.HOME).toContain(first.tmp.root);
    expect(second.env.RUMO_CONFIG_DIR).toBe(second.tmp.path('cli', 'config'));
  });

  it('reports a failing rumo init with its output', async () => {
    const user = await noLoginUser(server);
    const keyCalls = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, keyCalls.user, DEFAULT_PASSPHRASE);
    await expect(
      enrolledMachine({ url: server.url, tmp }, user, { key, name: 'gamma', initArgs: ['--fail'] }),
    ).rejects.toThrow(/rumo init exited 3/);
  });

  it('skips rumo init on request and can read events as the machine', async () => {
    const user = await noLoginUser(server);
    const keyCalls = recordingUser({ 'client.keys.get': { setup: null } });
    const key = await unlockedKey(server, keyCalls.user, DEFAULT_PASSPHRASE);
    const machine = await enrolledMachine({ url: server.url, tmp }, user, {
      key,
      name: 'delta',
      init: false,
    });
    const stream = await machine.events();
    expect((await stream.nextEvent()).event).toBe('tasks');
    stream.close();
    await stream.closed;
    const version = await machine.ok('machine.version', {});
    expect(version.owner).toBe('tester');
  });
});

describe('login board and board pair', () => {
  async function envOf(url: string, name: string): Promise<string | null> {
    return ((await (await fetch(`${url}/env/${name}`)).json()) as { value: string | null }).value;
  }

  it('starts the fake identity providers first and points the API at them', async () => {
    const board = await startLoginBoard({
      saml: true,
      passkeys: true,
      signupToken: 'signup-1',
      allowedOrigins: ['http://localhost:1'],
    });
    try {
      expect(board.url).toBe(board.origin);
      expect(await envOf(board.url, 'AUTH_MODE')).toBe('login');
      expect(await envOf(board.url, 'PUBLIC_URL')).toBe(board.origin);
      expect(await envOf(board.url, 'OIDC_ISSUER')).toBe(board.oidc?.url);
      expect(await envOf(board.url, 'PASSKEYS')).toBe('on');
      expect(await envOf(board.url, 'SIGNUP_TOKEN')).toBe('signup-1');
      expect(await envOf(board.url, 'ALLOWED_ORIGINS')).toBe('http://localhost:1');
      expect(await envOf(board.url, 'SAML_IDP_METADATA_URL')).toBe(`${board.saml?.url}/metadata`);
      const discovery = await fetch(`${board.oidc?.url}/.well-known/openid-configuration`);
      expect(discovery.status).toBe(200);
    } finally {
      await board.stop();
    }
    await expect(fetch(`${board.oidc?.url}/jwks`)).rejects.toThrow();
  });

  it('starts two boards that allow each other as an origin', async () => {
    const pair = await startBoardPair({ auth: 'no-login' });
    try {
      expect(await envOf(pair.a.url, 'ALLOWED_ORIGINS')).toBe(pair.b.url);
      expect(await envOf(pair.b.url, 'ALLOWED_ORIGINS')).toBe(pair.a.url);
      expect(pair.a.url).not.toBe(pair.b.url);
      expect(pair.a.tmp.root).not.toBe(pair.b.tmp.root);
    } finally {
      await pair.stop();
    }
  });
});

describe('launchDatabaseKind', () => {
  const withPostgres = { E2E_POSTGRES_URL: 'postgres://x' };

  it('uses Postgres only when the run allows it and the URL is set', () => {
    expect(launchDatabaseKind({ postgresAllowed: true }, withPostgres)).toBe('postgres');
    expect(launchDatabaseKind({}, withPostgres)).toBe('postgres');
    expect(launchDatabaseKind({ postgresAllowed: false }, withPostgres)).toBe('pglite');
    expect(launchDatabaseKind({ postgresAllowed: true }, {})).toBe('pglite');
  });

  it('lets an explicit database win', () => {
    expect(launchDatabaseKind({ database: 'pglite' }, withPostgres)).toBe('pglite');
    expect(launchDatabaseKind({ database: 'postgres', postgresAllowed: false }, {})).toBe(
      'postgres',
    );
  });
});

describe('postgresAllowedIn', () => {
  it('allows Postgres only in the desktop Chromium project', () => {
    expect(postgresAllowedIn('chromium-desktop')).toBe(true);
    for (const project of ['webkit-desktop', 'chromium-phone', 'webkit-phone']) {
      expect(postgresAllowedIn(project)).toBe(false);
    }
  });
});

describe('retryOnPortRace', () => {
  it('retries once when the first start lost a port race', async () => {
    let calls = 0;
    const result = await retryOnPortRace(async () => {
      calls += 1;
      if (calls === 1) throw new Error('listen EADDRINUSE: address already in use');
      return 'started';
    });
    expect(result).toBe('started');
    expect(calls).toBe(2);
  });

  it('does not retry any other failure', async () => {
    let calls = 0;
    await expect(
      retryOnPortRace(async () => {
        calls += 1;
        throw new Error('the database is gone');
      }),
    ).rejects.toThrow('the database is gone');
    expect(calls).toBe(1);
  });

  it('gives up when the second start fails too', async () => {
    let calls = 0;
    await expect(
      retryOnPortRace(async () => {
        calls += 1;
        throw new Error('API not ready after 20000 ms');
      }),
    ).rejects.toThrow('not ready');
    expect(calls).toBe(2);
  });
});

describe('retryOnBindRace', () => {
  it('retries a lost bind until a start succeeds', async () => {
    let calls = 0;
    const result = await retryOnBindRace(async () => {
      calls += 1;
      if (calls < 3) throw new Error('listen EADDRINUSE: address already in use');
      return 'started';
    });
    expect(result).toBe('started');
    expect(calls).toBe(3);
  });

  it('gives up after three lost binds', async () => {
    let calls = 0;
    await expect(
      retryOnBindRace(async () => {
        calls += 1;
        throw new Error('listen EADDRINUSE: address already in use');
      }),
    ).rejects.toThrow('EADDRINUSE');
    expect(calls).toBe(3);
  });

  it('does not retry a slow start', async () => {
    let calls = 0;
    await expect(
      retryOnBindRace(async () => {
        calls += 1;
        throw new Error('API not ready after 20000 ms');
      }),
    ).rejects.toThrow('not ready');
    expect(calls).toBe(1);
  });
});
