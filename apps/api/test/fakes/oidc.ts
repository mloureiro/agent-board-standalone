import { createHash, randomBytes } from 'node:crypto';

import { listen, readBody, sendJson, type FakeServer } from './http.js';

export const OIDC_CLIENT_ID = 'board-test';
export const OIDC_CLIENT_SECRET = 'board-test-secret';

export interface FakeOidc extends FakeServer {
  claims: Record<string, unknown>;
  refreshTokens: boolean;
  revoked: boolean;
  nonceOverride: string | null;
  requests: { path: string; params: URLSearchParams }[];
  authorize(authorizeUrl: string): Promise<URL>;
}

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

export const startFakeOidc = async (): Promise<FakeOidc> => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    kid: 'k1',
    alg: 'ES256',
  };
  const codes = new Map<string, { challenge: string; nonce: string | null; redirectUri: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();

  const state: Omit<FakeOidc, keyof FakeServer | 'authorize'> = {
    claims: {
      sub: 'subject-1',
      preferred_username: 'Ada',
      email: 'ada@example.test',
      groups: ['board-users'],
    },
    refreshTokens: false,
    revoked: false,
    nonceOverride: null,
    requests: [],
  };

  const sign = async (payload: Record<string, unknown>): Promise<string> => {
    const head = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1' }));
    const body = base64url(JSON.stringify(payload));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      Buffer.from(`${head}.${body}`),
    );
    return `${head}.${body}.${base64url(Buffer.from(signature))}`;
  };

  const { server, url } = await listen((issuer) => async (request, response, target) => {
    const body = request.method === 'POST' ? await readBody(request) : '';
    const params = request.method === 'POST' ? new URLSearchParams(body) : target.searchParams;
    state.requests.push({ path: target.pathname, params });
    if (target.pathname === '/.well-known/openid-configuration')
      return sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    if (target.pathname === '/jwks') return sendJson(response, 200, { keys: [jwk] });
    if (target.pathname === '/authorize') {
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce'),
        redirectUri: params.get('redirect_uri') ?? '',
      });
      const back = new URL(params.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    if (target.pathname === '/token') {
      const basic = Buffer.from(
        (request.headers.authorization ?? '').replace(/^Basic /, ''),
        'base64',
      ).toString();
      if (decodeURIComponent(basic) !== `${OIDC_CLIENT_ID}:${OIDC_CLIENT_SECRET}`)
        return sendJson(response, 401, { error: 'invalid_client' });
      const issued = Math.floor(Date.now() / 1000);
      const tokens = async (nonce: string | null) => {
        const access = randomBytes(12).toString('hex');
        accessTokens.add(access);
        const refresh = state.refreshTokens ? randomBytes(12).toString('hex') : null;
        if (refresh !== null) refreshTokens.add(refresh);
        return {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          ...(refresh === null ? {} : { refresh_token: refresh }),
          id_token: await sign({
            ...state.claims,
            iss: issuer,
            aud: OIDC_CLIENT_ID,
            iat: issued,
            exp: issued + 3600,
            ...(nonce === null ? {} : { nonce }),
          }),
        };
      };
      if (params.get('grant_type') === 'refresh_token') {
        const refresh = params.get('refresh_token') ?? '';
        if (state.revoked || !refreshTokens.delete(refresh))
          return sendJson(response, 400, { error: 'invalid_grant' });
        return sendJson(response, 200, await tokens(null));
      }
      const pending = codes.get(params.get('code') ?? '');
      codes.delete(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      if (
        pending === undefined ||
        createHash('sha256').update(verifier).digest('base64url') !== pending.challenge
      )
        return sendJson(response, 400, { error: 'invalid_grant' });
      return sendJson(response, 200, await tokens(state.nonceOverride ?? pending.nonce));
    }
    if (target.pathname === '/userinfo') {
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      if (state.revoked || !accessTokens.has(bearer))
        return sendJson(response, 401, { error: 'invalid_token' });
      return sendJson(response, 200, state.claims);
    }
    return sendJson(response, 404, {});
  });

  return Object.assign(state, {
    ...server,
    url,
    authorize: async (authorizeUrl: string): Promise<URL> => {
      const answer = await fetch(authorizeUrl, { redirect: 'manual' });
      return new URL(answer.headers.get('location') ?? '');
    },
  });
};
