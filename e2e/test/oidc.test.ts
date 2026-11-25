import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startOidcFake, type FakeHandle } from '../src/fakes/process.ts';

const CLIENT_ID = 'board-client';
const CLIENT_SECRET = 'board-secret';
const REDIRECT_URI = 'http://localhost:9999/auth/callback';

interface Claims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  nonce: string;
  groups: string[];
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  code_challenge_methods_supported: string[];
  id_token_signing_alg_values_supported: string[];
}

let fake: FakeHandle;

beforeAll(async () => {
  fake = await startOidcFake({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });
});

afterAll(async () => {
  await fake.stop();
});

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function authorize(
  params: Record<string, string>,
): Promise<{ status: number; location: URL | null }> {
  const url = new URL(`${fake.url}/authorize`);
  const all = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile groups',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge_method: 'S256',
    ...params,
  };
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  return { status: response.status, location: location === null ? null : new URL(location) };
}

function tokenRequest(form: Record<string, string>, basic = true): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(form);
  if (basic) {
    headers.authorization = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  }
  return fetch(`${fake.url}/token`, { method: 'POST', headers, body });
}

async function verifyJwt(token: string): Promise<Claims> {
  const [header, payload, signature] = token.split('.');
  const jwks = (await (await fetch(`${fake.url}/jwks`)).json()) as { keys: JsonWebKey[] };
  const key = await crypto.subtle.importKey(
    'jwk',
    jwks.keys[0] as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature ?? '', 'base64url'),
    Buffer.from(`${header}.${payload}`),
  );
  expect(valid).toBe(true);
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Claims;
}

describe('fake OIDC provider', () => {
  it('serves a discovery document pointing at its own endpoints', async () => {
    const document = (await (
      await fetch(`${fake.url}/.well-known/openid-configuration`)
    ).json()) as Claims;
    expect(document.issuer).toBe(fake.url);
    expect(document.authorization_endpoint).toBe(`${fake.url}/authorize`);
    expect(document.token_endpoint).toBe(`${fake.url}/token`);
    expect(document.jwks_uri).toBe(`${fake.url}/jwks`);
    expect(document.code_challenge_methods_supported).toEqual(['S256']);
    expect(document.id_token_signing_alg_values_supported).toEqual(['ES256']);
  });

  it('completes a code flow with PKCE and issues a verifiable id token', async () => {
    const { verifier, challenge } = pkce();
    const approved = await authorize({ code_challenge: challenge });
    expect(approved.status).toBe(302);
    const returned = approved.location as URL;
    expect(returned.origin + returned.pathname).toBe(REDIRECT_URI);
    expect(approved.location?.searchParams.get('state')).toBe('state-1');
    const code = approved.location?.searchParams.get('code') ?? '';

    const response = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Record<string, string>;
    const claims = await verifyJwt(tokens.id_token ?? '');
    expect(claims).toMatchObject({
      iss: fake.url,
      aud: CLIENT_ID,
      nonce: 'nonce-1',
      groups: ['board-users', 'board-admins'],
    });
    expect(claims.sub).toBeTruthy();
    expect(claims.email).toBeTruthy();

    const userinfo = await fetch(`${fake.url}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await userinfo.json()).toMatchObject({ sub: claims.sub, groups: claims.groups });
    expect((await fetch(`${fake.url}/userinfo`)).status).toBe(401);
  });

  it('accepts client credentials in the form body', async () => {
    const { verifier, challenge } = pkce();
    const code =
      (await authorize({ code_challenge: challenge })).location?.searchParams.get('code') ?? '';
    const response = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
      false,
    );
    expect(response.status).toBe(200);
  });

  it('refuses a wrong code verifier and a replayed code', async () => {
    const { verifier, challenge } = pkce();
    const code =
      (await authorize({ code_challenge: challenge })).location?.searchParams.get('code') ?? '';
    const wrong = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: 'not-the-verifier',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });

    const replay = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });
    expect(replay.status).toBe(400);
  });

  it('refuses a wrong client secret', async () => {
    const response = await fetch(`${fake.url}/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${CLIENT_ID}:nope`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'authorization_code' }),
    });
    expect(response.status).toBe(401);
  });

  it('requires PKCE S256 on authorize', async () => {
    const result = await authorize({ code_challenge: '', code_challenge_method: 'plain' });
    expect(result.location?.searchParams.get('error')).toBe('invalid_request');
    expect(result.location?.searchParams.get('state')).toBe('state-1');
  });

  it('rejects an unknown redirect uri without redirecting', async () => {
    const result = await authorize({ redirect_uri: 'http://evil.test/cb', code_challenge: 'x' });
    expect(result.status).toBe(400);
    expect(result.location).toBeNull();
  });

  it('answers the next authorize with access_denied once, then recovers', async () => {
    await fake.failNext();
    const denied = await authorize({ code_challenge: pkce().challenge });
    expect(denied.location?.searchParams.get('error')).toBe('access_denied');
    expect(denied.location?.searchParams.get('state')).toBe('state-1');
    expect(denied.location?.searchParams.get('code')).toBeNull();

    const next = await authorize({ code_challenge: pkce().challenge });
    expect(next.location?.searchParams.get('code')).toBeTruthy();
  });
});
