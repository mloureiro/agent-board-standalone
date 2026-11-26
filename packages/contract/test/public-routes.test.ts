import { describe, expect, it } from 'vitest';

import {
  CLIENT_WRITE_ERRORS,
  COMMON_ERRORS,
  CONTRACT,
  FEATURES,
  MIN_CLIENT,
  SESSION_STATES,
  SIGN_IN_METHODS,
  routeByName,
  routes,
  uiMachineCatalog,
  uiMachineFeeds,
  type AnyRoute,
  type RouteName,
} from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const time = '2026-11-13T10:00:00.000Z';
const verifier = 'v'.repeat(43);
const challenge = 'c'.repeat(43);
const publicKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE';
const clientToken = `abc_${'A'.repeat(43)}`;
const request = (name: RouteName, value: unknown) =>
  (routeByName(name) as AnyRoute).request.safeParse(value);
const response = (name: RouteName, value: unknown) =>
  (routeByName(name) as AnyRoute).response.safeParse(value);

const authentication = {
  id: 'abc',
  rawId: 'abc',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'e30', signature: 'e30' },
};
const registration = {
  id: 'abc',
  rawId: 'abc',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'e30' },
};

describe('route table totals', () => {
  it('[contract-003] every route of the table is public, client or machine and its path is unique', () => {
    expect(routes).toHaveLength(148);
    for (const entry of routes) expect(['public', 'client', 'machine']).toContain(entry.auth);
    const paths = routes.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    const counts = { public: 0, client: 0, machine: 0 };
    for (const entry of routes) counts[entry.auth] += 1;
    expect(counts).toEqual({ public: 15, client: 75, machine: 58 });
  });

  it('[contract-003] public and auth routes sit under /api/auth, /api/version, /api/pair or /healthz', () => {
    const names = routes
      .filter((entry) => entry.name.startsWith('public.') || entry.name.startsWith('auth.'))
      .map((entry) => `${entry.method} ${entry.path}`)
      .sort();
    expect(names).toEqual([
      'GET /api/auth/config',
      'GET /api/auth/handoff/describe',
      'GET /api/version',
      'GET /healthz',
      'POST /api/auth/handoff/approve',
      'POST /api/auth/handoff/finish',
      'POST /api/auth/handoff/start',
      'POST /api/auth/logout',
      'POST /api/auth/oidc/finish',
      'POST /api/auth/oidc/start',
      'POST /api/auth/passkey/login',
      'POST /api/auth/passkey/login-options',
      'POST /api/auth/passkey/signup',
      'POST /api/auth/passkey/signup-options',
      'POST /api/auth/saml/acs',
      'POST /api/auth/saml/finish',
      'POST /api/auth/saml/start',
      'POST /api/pair',
    ]);
    for (const entry of routes.filter((candidate) => candidate.path.startsWith('/api/auth/'))) {
      expect(entry.name).toBe(`auth.${entry.path.slice('/api/auth/'.length).replaceAll('/', '.')}`);
    }
  });

  it('[contract-003] hand-off approve and finish, pair, sign-in finishes, register-key and machines/issue carry issuesCredential, and no other route does', () => {
    expect(
      routes
        .filter((entry) => entry.issuesCredential)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([
      'auth.handoff.approve',
      'auth.handoff.finish',
      'auth.oidc.finish',
      'auth.passkey.login',
      'auth.passkey.signup',
      'auth.saml.finish',
      'client.account.import',
      'client.machines.issue',
      'client.passkeys.register',
      'machine.register-key',
      'public.pair',
    ]);
  });

  it('[contract-003] pairing carries its feature and every sign-in finish accepts a public key', () => {
    expect(routeByName('public.pair').feature).toBe('pairing');
    expect(FEATURES).toContain('pairing');
    for (const name of ['auth.oidc.finish', 'auth.saml.finish', 'auth.handoff.finish'] as const) {
      const base = {
        'auth.oidc.finish': { code: 'x', state: 'flow-1', verifier },
        'auth.saml.finish': { flow: 'flow-1', verifier },
        'auth.handoff.finish': { flow: 'flow-1', verifier },
      }[name];
      expect(request(name, base).success).toBe(true);
      expect(request(name, { ...base, publicKey }).success).toBe(true);
      expect(request(name, { ...base, publicKey: '' }).success).toBe(false);
      expect(request(name, { ...base, publicKey: 'a'.repeat(201) }).success).toBe(false);
      expect(request(name, { ...base, publicKey: 'not base64url!' }).success).toBe(false);
    }
    expect(
      request('auth.passkey.login', { flow: 'flow-1', response: authentication, publicKey })
        .success,
    ).toBe(true);
    expect(
      request('auth.passkey.signup', { flow: 'flow-1', response: registration, publicKey }).success,
    ).toBe(true);
  });
});

describe('sign-in failures and tokens', () => {
  it('[contract-008] no /api/auth route declares unauthorized', () => {
    const auth = routes.filter((entry) => entry.path.startsWith('/api/auth/'));
    expect(auth.length).toBeGreaterThan(0);
    for (const entry of auth) expect(entry.errors, entry.name).not.toContain('unauthorized');
    for (const entry of auth.filter((candidate) => candidate.auth === 'public')) {
      expect(COMMON_ERRORS.public).not.toContain('unauthorized');
      expect(entry.errors).not.toContain('signature-invalid');
      expect(entry.errors).not.toContain('key-unknown');
    }
    expect(routeByName('auth.handoff.finish').errors).toEqual(
      expect.arrayContaining(['forbidden', 'too-many-requests']),
    );
  });

  it('[contract-008] hand-off finish returns an abc_ client token only when tokenKind is client', () => {
    const finish = { flow: 'flow-1', verifier };
    expect(request('auth.handoff.finish', { ...finish, tokenKind: 'client' }).success).toBe(true);
    expect(request('auth.handoff.finish', { ...finish, tokenKind: 'cookie' }).success).toBe(true);
    expect(request('auth.handoff.finish', { ...finish, tokenKind: 'machine' }).success).toBe(false);
    expect(response('auth.handoff.finish', { status: 'pending' }).success).toBe(true);
    expect(response('auth.handoff.finish', { status: 'signed-in' }).success).toBe(true);
    expect(
      response('auth.handoff.finish', { status: 'signed-in', token: clientToken }).success,
    ).toBe(true);
    for (const wrong of ['abs_', 'abm_']) {
      expect(
        response('auth.handoff.finish', {
          status: 'signed-in',
          token: `${wrong}${'A'.repeat(43)}`,
        }).success,
      ).toBe(false);
    }
    expect(response('auth.handoff.finish', { status: 'pending', token: clientToken }).success).toBe(
      false,
    );
    for (const entry of routes.filter((candidate) => candidate.path.startsWith('/api/auth/'))) {
      if (entry.name === 'auth.handoff.finish') continue;
      expect(entry.response.safeParse({ ok: true, token: clientToken }).success).toBe(false);
    }
  });

  it('[contract-008] client writes declare unsupported-media-type through the common errors', () => {
    expect(CLIENT_WRITE_ERRORS).toContain('unsupported-media-type');
    expect(CLIENT_WRITE_ERRORS).toContain('origin-refused');
    for (const entry of routes.filter((candidate) => candidate.auth === 'client')) {
      expect(entry.errors, entry.name).not.toContain('unsupported-media-type');
      expect(entry.errors, entry.name).not.toContain('origin-refused');
    }
    for (const kind of ['public', 'machine'] as const) {
      expect(COMMON_ERRORS[kind]).not.toContain('unsupported-media-type');
    }
  });
});

describe('public routes', () => {
  it('[contract-003] the version document carries the handshake fields and nothing else', () => {
    const document = {
      contract: CONTRACT,
      minClient: MIN_CLIENT,
      features: [...FEATURES],
      server: { version: '1.0.0', commit: 'abc1234' },
      modules: {
        signIn: [...SIGN_IN_METHODS],
        requestSignature: false,
        scheduling: true,
        feeds: true,
      },
      session: 'none',
    };
    expect(response('public.version', document).success).toBe(true);
    expect(response('public.version', { ...document, extra: 1 }).success).toBe(false);
    for (const session of SESSION_STATES) {
      expect(response('public.version', { ...document, session }).success).toBe(true);
    }
    expect(response('public.version', { ...document, session: 'other' }).success).toBe(false);
    expect(
      response('public.version', {
        ...document,
        modules: { ...document.modules, signIn: ['password'] },
      }).success,
    ).toBe(false);
    expect(routeByName('public.version').method).toBe('GET');
    expect(response('public.healthz', { status: 'ok' }).success).toBe(true);
    expect(response('public.healthz', { status: 'down' }).success).toBe(false);
  });

  it('[contract-003] pair takes an XXXX-XXXX code, a public key and a label', () => {
    const pair = { code: 'AB12-CD34', publicKey, label: 'laptop' };
    expect(request('public.pair', pair).success).toBe(true);
    for (const code of ['ab12-cd34', 'AB12CD34', 'AB1-CD34', 'AB12-CD345']) {
      expect(request('public.pair', { ...pair, code }).success).toBe(false);
    }
    expect(request('public.pair', { ...pair, label: '' }).success).toBe(false);
    expect(request('public.pair', { ...pair, label: 'l'.repeat(65) }).success).toBe(false);
    expect(response('public.pair', { keyId: '0123456789abcdef' }).success).toBe(true);
    expect(routeByName('public.pair').errors).toEqual(['forbidden', 'too-many-requests']);
  });

  it('[contract-003] auth.config answers either no login or the sign-in offer', () => {
    expect(response('auth.config', { login: false }).success).toBe(true);
    const offer = {
      login: true,
      passkeys: true,
      signup: false,
      oidc: { label: 'Company' },
      saml: null,
    };
    expect(response('auth.config', offer).success).toBe(true);
    expect(response('auth.config', { login: true }).success).toBe(false);
    expect(response('auth.config', { ...offer, login: false }).success).toBe(false);
  });

  it('[contract-003] redirect flows start with a 43 character challenge and finish with a verifier', () => {
    for (const name of ['auth.oidc.start', 'auth.saml.start', 'auth.handoff.start'] as const) {
      expect(request(name, { challenge }).success).toBe(true);
      expect(request(name, { challenge: 'short' }).success).toBe(false);
      expect(request(name, {}).success).toBe(false);
    }
    expect(response('auth.oidc.start', { url: 'https://idp.example/authorize?x=1' }).success).toBe(
      true,
    );
    expect(response('auth.oidc.start', { url: 'not a url' }).success).toBe(false);
    expect(request('auth.saml.finish', { flow: 'flow-1', verifier: 'short' }).success).toBe(false);
    expect(
      request('auth.oidc.finish', { code: 'x', state: 'flow-1', verifier, iss: 'https://idp' })
        .success,
    ).toBe(true);
    expect(response('auth.handoff.start', { flow: 'flow-1', code: 'AB12-CD34' }).success).toBe(
      true,
    );
    expect(response('auth.handoff.start', { flow: 'flow-1', code: 'AB12CD34' }).success).toBe(
      false,
    );
  });

  it('[contract-003] the SAML assertion consumer takes a form and answers a redirect', () => {
    const acs = routeByName('auth.saml.acs');
    expect(acs.bodyType).toBe('form');
    expect(acs.bodyLimit).toBe(256 * 1024);
    expect(acs.request.safeParse({ SAMLResponse: 'PHNhbWw+', RelayState: 'x' }).success).toBe(true);
    expect(acs.request.safeParse({ SAMLResponse: 'PHNhbWw+' }).success).toBe(true);
    expect(acs.request.safeParse({ RelayState: 'x' }).success).toBe(false);
    expect(acs.response.safeParse({}).success).toBe(false);
    expect(acs.response.safeParse(undefined).success).toBe(false);
  });

  it('[contract-003] passkey sign-in takes the WebAuthn JSON forms', () => {
    expect(
      response('auth.passkey.login-options', {
        options: { challenge: 'Y2hhbGxlbmdl', rpId: 'board.example', allowCredentials: [] },
        flow: 'flow-1',
      }).success,
    ).toBe(true);
    expect(
      request('auth.passkey.login', { flow: 'flow-1', response: authentication }).success,
    ).toBe(true);
    expect(
      request('auth.passkey.login', {
        flow: 'flow-1',
        response: { ...authentication, response: { clientDataJSON: 'e30' } },
      }).success,
    ).toBe(false);
    expect(
      request('auth.passkey.signup-options', { username: 'owner', signupToken: 'token' }).success,
    ).toBe(true);
    expect(request('auth.passkey.signup-options', { username: 'owner' }).success).toBe(false);
    expect(
      request('auth.passkey.signup', { flow: 'flow-1', response: registration, name: '' }).success,
    ).toBe(true);
    expect(
      request('auth.passkey.signup', {
        flow: 'flow-1',
        response: registration,
        name: 'n'.repeat(201),
      }).success,
    ).toBe(false);
    expect(response('auth.passkey.login', { ok: true }).success).toBe(true);
    expect(response('auth.passkey.login', { ok: false }).success).toBe(false);
  });

  it('[contract-003] logout and the hand-off approval are client routes, the finish is public', () => {
    expect(routeByName('auth.logout').auth).toBe('client');
    expect(routeByName('auth.handoff.describe').auth).toBe('client');
    expect(routeByName('auth.handoff.describe').method).toBe('GET');
    expect(routeByName('auth.handoff.approve').auth).toBe('client');
    expect(routeByName('auth.handoff.finish').auth).toBe('public');
    expect(request('auth.handoff.describe', { flow: 'flow-1' }).success).toBe(true);
    expect(response('auth.handoff.describe', { code: 'AB12-CD34' }).success).toBe(true);
    expect(response('auth.handoff.approve', { ok: true }).success).toBe(true);
    expect(response('auth.logout', {}).success).toBe(true);
  });
});

describe('machine names stored before the name rule', () => {
  it('[contract-003] machine catalogs and feeds accept a stored legacy name', () => {
    const legacy = 'Old Laptop (2019)';
    expect(
      uiMachineCatalog.safeParse({ name: legacy, catalog: sealed, catalogUpdatedAt: time }).success,
    ).toBe(true);
    expect(
      uiMachineFeeds.safeParse({
        name: legacy,
        lastSeenAt: null,
        feeds: sealed,
        feedsUpdatedAt: time,
        feedRequests: [],
      }).success,
    ).toBe(true);
    expect(
      uiMachineCatalog.safeParse({ name: '', catalog: null, catalogUpdatedAt: null }).success,
    ).toBe(false);
    expect(
      uiMachineCatalog.safeParse({
        name: 'n'.repeat(257),
        catalog: null,
        catalogUpdatedAt: null,
      }).success,
    ).toBe(false);
  });
});
