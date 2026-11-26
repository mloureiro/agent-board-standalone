import { randomBytes } from 'node:crypto';

import * as client from 'openid-client';

import type { Clock } from '../clock.js';
import type { Json } from '../db/system.js';
import { ApiError } from '../errors.js';
import type { Database } from '../modules/database/index.js';
import type { OidcSettings } from '../modules/sign-in/index.js';
import { parseProviderUsername } from './provider-user.js';

export const OIDC_RETURN_PATH = '/auth/callback';

const DEFAULT_USERNAME_CLAIMS = ['preferred_username', 'email'];
const EMAIL_CLAIM = 'email';
const REJECTED_STATUSES = new Set([400, 401, 403]);

export interface OidcDeps {
  database: Database;
  clock: Clock;
  publicUrl: string;
  settings: OidcSettings;
  allowedGroups: string[];
}

export interface OidcIdentity {
  username: string;
  issuer: string;
  subject: string;
  upkeep: Json | null;
}

type Claims = Record<string, unknown>;

export const oidcConfiguration = async (settings: OidcSettings): Promise<client.Configuration> => {
  const execute = settings.allowHttp ? [client.allowInsecureRequests] : [];
  const found = await client.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret,
    undefined,
    { execute },
  );
  const methods = found.serverMetadata().token_endpoint_auth_methods_supported;
  const basic = methods === undefined || methods.includes('client_secret_basic');
  const configuration = new client.Configuration(
    found.serverMetadata(),
    settings.clientId,
    { client_secret: settings.clientSecret },
    basic
      ? client.ClientSecretBasic(settings.clientSecret)
      : client.ClientSecretPost(settings.clientSecret),
  );
  for (const apply of execute) apply(configuration);
  return configuration;
};

const redirectUri = (publicUrl: string): string => `${publicUrl}${OIDC_RETURN_PATH}`;

const randomToken = (): string => randomBytes(32).toString('base64url');

export interface OidcChecks {
  nonce: string;
  pkceVerifier: string;
}

export const newOidcChecks = (): OidcChecks => ({
  nonce: randomToken(),
  pkceVerifier: client.randomPKCECodeVerifier(),
});

export const authorizationUrl = async (
  deps: Pick<OidcDeps, 'publicUrl' | 'settings'>,
  state: string,
  checks: OidcChecks,
): Promise<string> => {
  const configuration = await oidcConfiguration(deps.settings);
  return client
    .buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri(deps.publicUrl),
      scope: deps.settings.scopes,
      state,
      nonce: checks.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(checks.pkceVerifier),
      code_challenge_method: 'S256',
    })
    .toString();
};

const groupsOf = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((group): group is string => typeof group === 'string');
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean);
};

const usernameOf = (settings: OidcSettings, claims: Claims): string | null => {
  const names =
    settings.usernameClaim === null ? DEFAULT_USERNAME_CLAIMS : [settings.usernameClaim];
  for (const name of names) {
    const username = parseProviderUsername(claims[name]);
    if (username === null) continue;
    return name === EMAIL_CLAIM && claims.email_verified !== true ? null : username;
  }
  return null;
};

export const acceptClaims = (
  settings: OidcSettings,
  allowedGroups: string[],
  claims: Claims,
): string => {
  const username = usernameOf(settings, claims);
  if (username === null)
    throw new ApiError('forbidden', 'the identity provider sent no usable user name');
  if (
    allowedGroups.length > 0 &&
    !groupsOf(claims[settings.groupsClaim]).some((group) => allowedGroups.includes(group))
  )
    throw new ApiError('forbidden', 'your account is not allowed on this board');
  return username;
};

const userinfoOf = async (
  configuration: client.Configuration,
  accessToken: string,
  subject: string | typeof client.skipSubjectCheck,
): Promise<Claims> => {
  if (configuration.serverMetadata().userinfo_endpoint === undefined) return {};
  return client.fetchUserInfo(configuration, accessToken, subject);
};

const upkeepOf = (refreshToken: string | undefined): Json | null =>
  refreshToken === undefined ? null : { refreshToken };

export const finishOidc = async (
  deps: OidcDeps,
  flowData: Json,
  input: { code: string; state: string; iss?: string | undefined },
): Promise<OidcIdentity> => {
  const configuration = await oidcConfiguration(deps.settings);
  const response = new URL(redirectUri(deps.publicUrl));
  response.searchParams.set('code', input.code);
  response.searchParams.set('state', input.state);
  if (input.iss !== undefined) response.searchParams.set('iss', input.iss);
  const tokens = await client.authorizationCodeGrant(configuration, response, {
    expectedState: input.state,
    expectedNonce: String(flowData.nonce),
    pkceCodeVerifier: String(flowData.pkceVerifier),
    idTokenExpected: true,
  });
  const idClaims = tokens.claims();
  if (idClaims === undefined) throw new Error('the identity provider sent no ID token');
  const userinfo = await userinfoOf(configuration, tokens.access_token, idClaims.sub).catch(
    () => ({}),
  );
  const username = acceptClaims(deps.settings, deps.allowedGroups, { ...userinfo, ...idClaims });
  return {
    username,
    issuer: idClaims.iss,
    subject: idClaims.sub,
    upkeep: upkeepOf(tokens.refresh_token),
  };
};

const isRejection = (error: unknown): boolean => {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && REJECTED_STATUSES.has(status);
};

export const oidcStillAccepts = async (
  deps: Pick<OidcDeps, 'settings' | 'allowedGroups'>,
  upkeep: Json,
): Promise<{ accepted: boolean; upkeep: Json }> => {
  try {
    const configuration = await oidcConfiguration(deps.settings);
    const tokens = await client.refreshTokenGrant(configuration, String(upkeep.refreshToken));
    const userinfo = await userinfoOf(configuration, tokens.access_token, client.skipSubjectCheck);
    acceptClaims(deps.settings, deps.allowedGroups, { ...userinfo, ...(tokens.claims() ?? {}) });
    return { accepted: true, upkeep: upkeepOf(tokens.refresh_token) ?? upkeep };
  } catch (error) {
    if (error instanceof ApiError || isRejection(error)) return { accepted: false, upkeep };
    return { accepted: true, upkeep };
  }
};
