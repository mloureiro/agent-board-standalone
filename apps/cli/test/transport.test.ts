import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CONTRACT,
  SIGNATURE_HEADERS,
  canonicalString,
  CLIENT_HEADER,
  CONTRACT_HEADER,
} from '@agent-board/contract';
import { importPublicKey, verify } from '@agent-board/sealing';
import { afterEach, describe, expect, it } from 'vitest';

import { clockOffsetMs, now } from '../src/transport/clock.js';
import { ApiError } from '../src/transport/errors.js';
import { assertCompatible, requireFeature, verdictOf } from '../src/transport/compatibility.js';
import { handshake } from '../src/transport/handshake.js';
import { REQUEST_TIMEOUT_MS, sendRequest, type HttpDeps } from '../src/transport/request.js';
import { parseMachineVersion, parsePublicVersion } from '../src/transport/server-info.js';
import { generateSigningKeyPair, loadSigner, saveSigningKey } from '../src/profile/signing-key.js';
import { statSync } from 'node:fs';
import { startBoard, TEST_TOKEN, type FakeBoard } from './support/board.js';
import { startServer, type FakeServer } from './support/server.js';
import { testRuntime, type TestRuntime } from './support/runtime.js';

const stoppers: (() => Promise<void>)[] = [];
let env: TestRuntime | undefined;

afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  env?.dispose();
  env = undefined;
});

async function board(options: Parameters<typeof startBoard>[0] = {}): Promise<FakeBoard> {
  const started = await startBoard(options);
  stoppers.push(() => started.stop());
  return started;
}

function depsFor(server: FakeServer, overrides: Partial<HttpDeps> = {}): HttpDeps {
  return {
    fetch: globalThis.fetch,
    baseUrl: server.url,
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe('request headers', () => {
  it('[cli-003] sends the bearer token, the contract headers and a JSON body to the machine route', async () => {
    const server = await board();
    await sendRequest(depsFor(server), {
      method: 'POST',
      path: '/api/machine/version',
      body: {},
      token: TEST_TOKEN,
    });
    const [seen] = server.seen;
    expect(seen?.method).toBe('POST');
    expect(seen?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(seen?.headers[CONTRACT_HEADER]).toBe(String(CONTRACT));
    expect(seen?.headers[CLIENT_HEADER]).toMatch(/^cli\/\d+\.\d+\.\d+$/);
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.body).toBe('{}');
  });

  it('can leave the contract headers off for a public read', async () => {
    const server = await board();
    await sendRequest(depsFor(server), {
      method: 'GET',
      path: '/api/version',
      contractHeaders: false,
    });
    expect(server.seen[0]?.headers[CONTRACT_HEADER]).toBeUndefined();
  });
});

describe('request failures', () => {
  it('turns an error body into an ApiError carrying status and code', async () => {
    const server = await board();
    const failure = sendRequest(depsFor(server), {
      method: 'POST',
      path: '/api/machine/version',
      body: {},
      token: 'abm_wrong',
    });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toThrow(/bad token \(401 unauthorized\)/);
  });

  it('[cli-003] does not follow redirects', async () => {
    const target = await startServer(() => ({ body: { reached: true } }));
    const redirecting = await startServer(() => ({
      status: 302,
      headers: { location: `${target.url}/elsewhere` },
    }));
    stoppers.push(
      () => target.stop(),
      () => redirecting.stop(),
    );
    await expect(
      sendRequest(depsFor(redirecting), { method: 'GET', path: '/api/version' }),
    ).rejects.toThrow(/redirect \(302\)/);
    expect(target.seen).toHaveLength(0);
  });

  it('[cli-003] gives up after the 45 s timeout', async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(45_000);
    const server = await startServer(() => ({ body: {} }));
    stoppers.push(() => server.stop());
    const timeoutError = new Error('timed out');
    timeoutError.name = 'TimeoutError';
    const fast: typeof fetch = () => Promise.reject(timeoutError);
    await expect(
      sendRequest(depsFor(server, { fetch: fast }), { method: 'GET', path: '/api/version' }),
    ).rejects.toThrow(/did not answer within 45 s/);
  });

  it('says where it tried to connect when the server is unreachable', async () => {
    const server = await startServer(() => ({ body: {} }));
    await server.stop();
    await expect(
      sendRequest(depsFor(server), { method: 'GET', path: '/api/version' }),
    ).rejects.toThrow(/could not reach the server at/);
  });
});

describe('request signing', () => {
  it('signs the method, path, timestamp, nonce and body digest with the stored key', async () => {
    const server = await startServer(() => ({ body: {} }));
    stoppers.push(() => server.stop());
    const generated = await generateSigningKeyPair();
    await sendRequest(depsFor(server), {
      method: 'POST',
      path: '/api/machine/list-tasks?x=1',
      body: { all: true },
      token: TEST_TOKEN,
      signer: generated.signer,
    });
    const seen = server.seen[0];
    if (seen === undefined) throw new Error('no request reached the server');
    const { headers, body } = seen;
    expect(headers[SIGNATURE_HEADERS.key]).toBe(generated.signer.keyId);
    expect(headers[SIGNATURE_HEADERS.ts]).toBe('1700000000');
    const digest = String(headers[SIGNATURE_HEADERS.digest]);
    expect(digest).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    const canonical = canonicalString({
      method: 'POST',
      pathWithQuery: '/api/machine/list-tasks?x=1',
      ts: 1_700_000_000,
      nonce: String(headers[SIGNATURE_HEADERS.nonce]),
      digest,
    });
    const publicKey = await importPublicKey(generated.signer.publicKey);
    expect(await verify(publicKey, canonical, String(headers[SIGNATURE_HEADERS.sig]))).toBe(true);
    expect(body).toBe('{"all":true}');
  });

  it('sends no signature headers without a key', async () => {
    const server = await board();
    await sendRequest(depsFor(server), { method: 'GET', path: '/api/version' });
    expect(server.seen[0]?.headers[SIGNATURE_HEADERS.sig]).toBeUndefined();
  });

  it('stores the key as signing-key.jwk with mode 600 and loads it back', async () => {
    env = testRuntime();
    const generated = await generateSigningKeyPair();
    expect(await loadSigner(env.path('config'))).toBeNull();
    saveSigningKey(env.path('config'), generated.jwk);
    expect(statSync(env.path('config', 'signing-key.jwk')).mode & 0o777).toBe(0o600);
    const loaded = await loadSigner(env.path('config'));
    expect(loaded?.keyId).toBe(generated.signer.keyId);
  });

  it('refuses a signing key that is loose or not a key', async () => {
    env = testRuntime();
    const dir = env.path('config');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'signing-key.jwk'), '{}', { mode: 0o600 });
    await expect(loadSigner(dir)).rejects.toThrow(/valid P-256 signing key/);
    chmodSync(path.join(dir, 'signing-key.jwk'), 0o644);
    await expect(loadSigner(dir)).rejects.toThrow(/must be 600 or 400/);
  });
});

describe('clock offset', () => {
  it('is honoured only when AGENT_BOARD_E2E is 1', () => {
    env = testRuntime();
    const file = env.path('offset');
    writeFileSync(file, '30\n');
    expect(clockOffsetMs({ AGENT_BOARD_E2E: '1', AGENT_BOARD_CLOCK_OFFSET_FILE: file })).toBe(
      30_000,
    );
    expect(clockOffsetMs({ AGENT_BOARD_CLOCK_OFFSET_FILE: file })).toBe(0);
    expect(clockOffsetMs({ AGENT_BOARD_E2E: '0', AGENT_BOARD_CLOCK_OFFSET_FILE: file })).toBe(0);
    expect(clockOffsetMs({ AGENT_BOARD_E2E: '1' })).toBe(0);
  });

  it('ignores a missing or unreadable offset file', () => {
    env = testRuntime();
    expect(
      clockOffsetMs({ AGENT_BOARD_E2E: '1', AGENT_BOARD_CLOCK_OFFSET_FILE: env.path('none') }),
    ).toBe(0);
    writeFileSync(env.path('bad'), 'soon');
    expect(
      clockOffsetMs({ AGENT_BOARD_E2E: '1', AGENT_BOARD_CLOCK_OFFSET_FILE: env.path('bad') }),
    ).toBe(0);
  });

  it('moves the clock by the offset', () => {
    env = testRuntime();
    writeFileSync(env.path('offset'), '-600');
    const shifted = now({
      AGENT_BOARD_E2E: '1',
      AGENT_BOARD_CLOCK_OFFSET_FILE: env.path('offset'),
    });
    expect(Date.now() - shifted).toBeGreaterThan(599_000);
  });
});

describe('handshake', () => {
  async function call(server: FakeServer, token = TEST_TOKEN) {
    return (command: string, body: unknown) =>
      sendRequest(depsFor(server), {
        method: 'POST',
        path: `/api/machine/${command}`,
        body,
        token,
      });
  }

  it('is a machine version call and returns what the server reports', async () => {
    const server = await board();
    const info = await handshake(await call(server), server.dataKey);
    expect(server.seen.map((entry) => entry.path)).toEqual(['/api/machine/version']);
    expect(info).toMatchObject({ version: '1.2.3', contract: CONTRACT, machine: 'test-machine' });
  });

  it('refuses a server whose contract demands a newer CLI, naming both versions', async () => {
    const server = await board({ contract: CONTRACT + 1, minClient: CONTRACT + 1 });
    const failure = handshake(await call(server), server.dataKey);
    await expect(failure).rejects.toThrow(/contract 1\)/);
    await expect(failure).rejects.toThrow(/contract 2 or newer/);
    await expect(failure).rejects.toThrow(/too old/);
  });

  it('refuses a data key whose derived key id differs from the server', async () => {
    const server = await board();
    const other = (await board()).dataKey;
    await expect(handshake(await call(server), other)).rejects.toThrow(
      /key id [0-9a-f]{16} does not match the server's key id/,
    );
  });

  it('refuses a server that has no key yet', async () => {
    const server = await board({ keyId: null });
    await expect(handshake(await call(server), server.dataKey)).rejects.toThrow(/no key set up/);
  });
});

describe('verdicts and feature gating', () => {
  const info = (overrides: Record<string, unknown> = {}) =>
    parsePublicVersion({
      contract: CONTRACT,
      minClient: { cli: 1, web: 1 },
      features: ['projects'],
      server: { version: '9.9.9', commit: null },
      modules: { requestSignature: false },
      ...overrides,
    });

  it('says compatible, client-too-old or server-too-old', () => {
    expect(verdictOf(info()).verdict).toBe('compatible');
    expect(verdictOf(info({ contract: 2, minClient: { cli: 2, web: 2 } })).verdict).toBe(
      'client-too-old',
    );
    const stub = info();
    expect(verdictOf({ ...stub, contract: 0 }).verdict).toBe('server-too-old');
  });

  it('[cli-005] refuses before sending a command whose feature the server lacks, naming it', () => {
    expect(() => requireFeature(info(), 'watches')).toThrow(/lacks the feature "watches"/);
    expect(() => requireFeature(info(), 'projects')).not.toThrow();
  });

  it('adds the upgrade hint to a too-old CLI', () => {
    expect(() => assertCompatible(info({ contract: 2, minClient: { cli: 2, web: 2 } }))).toThrow(
      /board self-update/,
    );
  });

  it('parses machine version answers leniently about extra fields', () => {
    const parsed = parseMachineVersion({
      contract: 1,
      minClient: { cli: 1, web: 1 },
      features: ['projects', 7],
      server: { version: '1.0.0' },
      owner: 'o',
      keyId: 'k',
      machine: 'm',
      grant: true,
      requestSignature: true,
      futureField: 1,
    });
    expect(parsed).toMatchObject({ features: ['projects'], grant: true, requestSignature: true });
    expect(() => parseMachineVersion('nope')).toThrow(/not a JSON object/);
    expect(() => parseMachineVersion({ contract: 'x', minClient: {} })).toThrow(/positive integer/);
  });
});
