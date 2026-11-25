import { CONTRACT, FEATURES, MIN_CLIENT, versionDocument } from '@agent-board/contract';
import { tokenHash } from '@agent-board/sealing';
import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialStore } from '../src/auth/index.js';
import {
  CLIENT_TOKEN,
  MACHINE_TOKEN,
  SESSION_TOKEN,
  boot,
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

describe('GET /api/version', () => {
  it('[api-115] reports contract, minimum clients, features, server build and enabled modules', async () => {
    const { app } = await started(
      noLoginEnv({ BUILD_VERSION: '1.2.3', GIT_SHA: 'abc1234', FEEDS: 'off' }),
    );
    const answer = await app.inject({ url: '/api/version' });
    expect(answer.statusCode).toBe(200);
    const document = versionDocument.parse(answer.json());
    expect(document).toMatchObject({
      contract: CONTRACT,
      minClient: MIN_CLIENT,
      server: { version: '1.2.3', commit: 'abc1234' },
      modules: { signIn: [], requestSignature: false, scheduling: true, feeds: false },
    });
    expect(document.features.length).toBeGreaterThan(0);
    for (const feature of document.features) expect(FEATURES).toContain(feature);
    expect(answer.headers['access-control-allow-origin']).toBe('*');
  });

  it('[api-115] lists the sign-in methods of a login server', async () => {
    const { app } = await started(
      loginEnv({
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'board',
        OIDC_CLIENT_SECRET: 'secret',
        SAML_IDP_METADATA_URL: 'https://idp.example/metadata',
      }),
    );
    const document = (await app.inject({ url: '/api/version' })).json();
    expect(document.modules.signIn).toEqual(['passkeys', 'handoff', 'oidc', 'saml']);
    const passkeysOff = await started(
      loginEnv({ PASSKEYS: 'off', SAML_IDP_METADATA_URL: 'https://x.example/metadata' }),
    );
    expect((await passkeysOff.app.inject({ url: '/api/version' })).json().modules.signIn).toEqual([
      'handoff',
      'saml',
    ]);
  });

  it('[api-115] request signature on adds its features, off removes them', async () => {
    const off = await started(noLoginEnv());
    const on = await started(noLoginEnv({ REQUEST_SIGNATURE: 'on' }));
    const without = (await off.app.inject({ url: '/api/version' })).json();
    const withIt = (await on.app.inject({ url: '/api/version' })).json();
    expect(without.features).not.toContain('request-signature');
    expect(without.features).not.toContain('pairing');
    expect(withIt.features).toEqual(expect.arrayContaining(['request-signature', 'pairing']));
    expect(withIt.modules.requestSignature).toBe(true);
  });

  it('[api-115] the session is not-required without login', async () => {
    const { app } = await started(noLoginEnv());
    const answer = await app.inject({
      url: '/api/version',
      headers: { cookie: `board-session=${SESSION_TOKEN}` },
    });
    expect(answer.json().session).toBe('not-required');
  });

  it('[api-115] the session is none, valid or expired by the credential that was sent', async () => {
    const sessionHash = await tokenHash(SESSION_TOKEN);
    const clientHash = await tokenHash(CLIENT_TOKEN);
    const credentials: CredentialStore = {
      findSession: async (hash) => {
        if (hash === sessionHash) return { owner: 'grace', expired: false };
        if (hash === clientHash) return { owner: 'grace', expired: true };
        return null;
      },
      findMachine: async () => ({ owner: 'grace', machineId: 'm1' }),
    };
    const { app } = await started(loginEnv(), { credentials });
    const stateOf = async (headers: Record<string, string>): Promise<string> =>
      (await app.inject({ url: '/api/version', headers })).json().session;

    expect(await stateOf({})).toBe('none');
    expect(await stateOf({ cookie: `board-session=${SESSION_TOKEN}` })).toBe('valid');
    expect(await stateOf({ authorization: `Bearer ${CLIENT_TOKEN}` })).toBe('expired');
    expect(await stateOf({ cookie: `board-session=abs_${'Z'.repeat(43)}` })).toBe('none');
    expect(await stateOf({ cookie: 'board-session=garbage' })).toBe('none');
    expect(await stateOf({ authorization: `Bearer ${SESSION_TOKEN}` })).toBe('none');
    expect(await stateOf({ authorization: `Bearer ${MACHINE_TOKEN}` })).toBe('none');
  });

  it('[api-115] a secure login server reads only the __Host- cookie', async () => {
    const hash = await tokenHash(SESSION_TOKEN);
    const credentials: CredentialStore = {
      findSession: async (given) => (given === hash ? { owner: 'grace', expired: false } : null),
      findMachine: async () => null,
    };
    const { app } = await started(loginEnv({ PUBLIC_URL: 'https://board.example.com' }), {
      credentials,
    });
    const stateOf = async (cookie: string): Promise<string> =>
      (await app.inject({ url: '/api/version', headers: { cookie } })).json().session;
    expect(await stateOf(`__Host-board-session=${SESSION_TOKEN}`)).toBe('valid');
    expect(await stateOf(`board-session=${SESSION_TOKEN}`)).toBe('none');
  });

  it('[api-115] needs no contract header and no credentials', async () => {
    const { app } = await started(loginEnv());
    const answer = await app.inject({ url: '/api/version' });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().session).toBe('none');
  });
});
