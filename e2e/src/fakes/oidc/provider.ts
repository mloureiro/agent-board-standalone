import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

import { readBody, redirect, sendJson, type Handler } from '../http.ts';

export interface OidcUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly groups: readonly string[];
}

export const DEFAULT_OIDC_USER: OidcUser = {
  sub: 'fake-oidc-user',
  email: 'oidc.user@example.test',
  name: 'Oidc User',
  groups: ['board-users', 'board-admins'],
};

export interface OidcProviderOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly user?: OidcUser;
}

interface PendingCode {
  readonly challenge: string;
  readonly nonce: string | null;
  readonly redirectUri: string;
  readonly scope: string;
}

const TOKEN_LIFETIME_SECONDS = 3600;
const KEY_ID = 'fake-oidc-key';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function equalSecrets(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: KEY_ID }));
  const body = base64url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    Buffer.from(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(Buffer.from(signature))}`;
}

function clientCredentials(
  request: http.IncomingMessage,
  form: URLSearchParams,
): { id: string; secret: string } {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      return {
        id: decodeURIComponent(decoded.slice(0, separator)),
        secret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    }
  }
  return { id: form.get('client_id') ?? '', secret: form.get('client_secret') ?? '' };
}

export interface OidcProvider {
  readonly handler: Handler;
}

export async function createOidcProvider(options: OidcProviderOptions): Promise<OidcProvider> {
  const user = options.user ?? DEFAULT_OIDC_USER;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = {
    ...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
    kid: KEY_ID,
    alg: 'ES256',
    use: 'sig',
  };
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Set<string>();
  let nextError: { error: string; description: string } | null = null;

  const claims = (): Record<string, unknown> => ({
    sub: user.sub,
    email: user.email,
    email_verified: true,
    name: user.name,
    groups: [...user.groups],
  });

  const authorize = (url: URL, response: http.ServerResponse): void => {
    const params = url.searchParams;
    if (params.get('client_id') !== options.clientId) {
      sendJson(response, 400, { error: 'unauthorized_client' });
      return;
    }
    if (params.get('redirect_uri') !== options.redirectUri) {
      sendJson(response, 400, { error: 'invalid_request', error_description: 'redirect_uri' });
      return;
    }
    const target = new URL(options.redirectUri);
    const state = params.get('state');
    if (state !== null) target.searchParams.set('state', state);

    const failure = nextError;
    nextError = null;
    if (failure !== null) {
      target.searchParams.set('error', failure.error);
      target.searchParams.set('error_description', failure.description);
      redirect(response, target.toString());
      return;
    }
    const challenge = params.get('code_challenge');
    if (
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      challenge === null ||
      challenge === ''
    ) {
      target.searchParams.set('error', 'invalid_request');
      target.searchParams.set('error_description', 'response_type=code and PKCE S256 are required');
      redirect(response, target.toString());
      return;
    }
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      challenge,
      nonce: params.get('nonce'),
      redirectUri: options.redirectUri,
      scope: params.get('scope') ?? 'openid',
    });
    target.searchParams.set('code', code);
    redirect(response, target.toString());
  };

  const token = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    const form = new URLSearchParams(await readBody(request));
    const credentials = clientCredentials(request, form);
    if (
      credentials.id !== options.clientId ||
      !equalSecrets(credentials.secret, options.clientSecret)
    ) {
      sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    if (form.get('grant_type') !== 'authorization_code') {
      sendJson(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const code = form.get('code') ?? '';
    const pending = codes.get(code);
    codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      pending === undefined ||
      form.get('redirect_uri') !== pending.redirectUri ||
      !equalSecrets(s256(verifier), pending.challenge)
    ) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const idToken = await signJwt(keys.privateKey, {
      ...claims(),
      iss: options.issuer,
      aud: options.clientId,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      ...(pending.nonce === null ? {} : { nonce: pending.nonce }),
    });
    const accessToken = randomBytes(24).toString('hex');
    accessTokens.add(accessToken);
    sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_LIFETIME_SECONDS,
      id_token: idToken,
      scope: pending.scope,
    });
  };

  const handler: Handler = async (request, response) => {
    const url = new URL(request.url ?? '/', options.issuer);
    const method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        issuer: options.issuer,
        authorization_endpoint: `${options.issuer}/authorize`,
        token_endpoint: `${options.issuer}/token`,
        userinfo_endpoint: `${options.issuer}/userinfo`,
        jwks_uri: `${options.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email', 'groups'],
        claims_supported: ['sub', 'email', 'name', 'groups', 'nonce'],
      });
    } else if (method === 'GET' && url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [publicJwk] });
    } else if (method === 'GET' && url.pathname === '/authorize') {
      authorize(url, response);
    } else if (method === 'POST' && url.pathname === '/token') {
      await token(request, response);
    } else if (method === 'GET' && url.pathname === '/userinfo') {
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (accessTokens.has(bearer)) sendJson(response, 200, claims());
      else sendJson(response, 401, { error: 'invalid_token' });
    } else if (method === 'POST' && url.pathname === '/control/next-error') {
      const body = (await readBody(request)).trim();
      const given =
        body === '' ? {} : (JSON.parse(body) as { error?: string; description?: string });
      nextError = {
        error: given.error ?? 'access_denied',
        description: given.description ?? 'The user denied access',
      };
      sendJson(response, 200, { armed: nextError });
    } else {
      sendJson(response, 404, { error: 'not_found' });
    }
  };

  return { handler };
}
