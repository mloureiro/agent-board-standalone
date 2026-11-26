import type { SignInMethod } from '@agent-board/contract';

import type { z } from 'zod';

import { SIGNUP_NAME_RULE } from '../../auth/passkeys.js';
import { csv, envObject, onOff, refuse } from '../env.js';

export interface NoLoginConfig {
  mode: 'no-login';
  user: string;
}

export interface LoginConfig {
  mode: 'login';
  publicUrl: string;
  rpId: string;
  scheme: 'http' | 'https';
  passkeys: boolean;
  signupToken: string | null;
  claimUser: string | null;
  allowedGroups: string[];
  sessionDays: number;
  oidc: OidcSettings | null;
  saml: SamlSettings | null;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string | null;
  groupsClaim: string;
  allowHttp: boolean;
}

export interface SamlSettings {
  metadataUrl: string;
  spEntityId: string;
  usernameAttribute: string | null;
  allowHttp: boolean;
}

export type SignInConfig = NoLoginConfig | LoginConfig;

export const MIN_SIGNUP_TOKEN_LENGTH = 32;
export const DEFAULT_SESSION_DAYS = 30;
const DEFAULT_OIDC_SCOPES = 'openid profile email';
const MAX_SESSION_DAYS = 365;
const MAX_USER_LENGTH = 128;
const LOGIN_ONLY_NAMES = [
  'PUBLIC_URL',
  'PASSKEYS',
  'SIGNUP_TOKEN',
  'CLAIM_USER',
  'ALLOWED_GROUPS',
  'SESSION_DAYS',
];
const LOGIN_ONLY_PREFIX = /^(OIDC_|SAML_)/;

export const signInMethods = (config: SignInConfig): SignInMethod[] => {
  if (config.mode === 'no-login') return [];
  const methods: SignInMethod[] = [];
  if (config.passkeys) methods.push('passkeys');
  methods.push('handoff');
  if (config.oidc) methods.push('oidc');
  if (config.saml) methods.push('saml');
  return methods;
};

const parsePublicUrl = (
  value: string,
  production: boolean,
  fail: (message: string) => void,
): URL | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('must be a URL such as https://board.example.com');
    return null;
  }
  const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!bare) {
    fail('must be a bare origin: scheme, host and port, with no path, query or credentials');
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    fail(production ? 'must be an https URL in production' : 'must be an http or https URL');
    return null;
  }
  return url;
};

const parseProviderUrl = (
  value: string,
  production: boolean,
  fail: (message: string) => void,
): { url: string; allowHttp: boolean } | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('must be a URL such as https://idp.example.com');
    return null;
  }
  if (url.protocol === 'https:') return { url: value, allowHttp: false };
  if (url.protocol === 'http:' && !production) return { url: value, allowHttp: true };
  fail(production ? 'must be an https URL in production' : 'must be an http or https URL');
  return null;
};

const parseOidc = (
  env: Record<string, string>,
  production: boolean,
  ctx: z.RefinementCtx,
): OidcSettings | null => {
  const names = ['OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_SCOPES', 'OIDC_USERNAME_CLAIM'];
  const issuer = env.OIDC_ISSUER;
  if (issuer === undefined) {
    for (const name of [...names, 'OIDC_GROUPS_CLAIM'])
      if (env[name] !== undefined) refuse(ctx, name, 'needs OIDC_ISSUER');
    return null;
  }
  const clientId = env.OIDC_CLIENT_ID;
  const clientSecret = env.OIDC_CLIENT_SECRET;
  if (clientId === undefined) refuse(ctx, 'OIDC_CLIENT_ID', 'is required with OIDC_ISSUER');
  if (clientSecret === undefined) refuse(ctx, 'OIDC_CLIENT_SECRET', 'is required with OIDC_ISSUER');
  const scopes = env.OIDC_SCOPES ?? DEFAULT_OIDC_SCOPES;
  if (!scopes.split(/\s+/).includes('openid'))
    refuse(ctx, 'OIDC_SCOPES', 'must include the openid scope');
  const parsed = parseProviderUrl(issuer, production, (message) =>
    refuse(ctx, 'OIDC_ISSUER', message),
  );
  if (parsed === null || clientId === undefined || clientSecret === undefined) return null;
  return {
    issuer: parsed.url,
    clientId,
    clientSecret,
    scopes,
    usernameClaim: env.OIDC_USERNAME_CLAIM ?? null,
    groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups',
    allowHttp: parsed.allowHttp,
  };
};

const parseSaml = (
  env: Record<string, string>,
  production: boolean,
  publicUrl: string,
  ctx: z.RefinementCtx,
): SamlSettings | null => {
  const metadataUrl = env.SAML_IDP_METADATA_URL;
  if (metadataUrl === undefined) {
    for (const name of ['SAML_SP_ENTITY_ID', 'SAML_USERNAME_ATTRIBUTE'])
      if (env[name] !== undefined) refuse(ctx, name, 'needs SAML_IDP_METADATA_URL');
    return null;
  }
  const parsed = parseProviderUrl(metadataUrl, production, (message) =>
    refuse(ctx, 'SAML_IDP_METADATA_URL', message),
  );
  if (parsed === null) return null;
  return {
    metadataUrl: parsed.url,
    spEntityId: env.SAML_SP_ENTITY_ID ?? `${publicUrl}/saml/metadata`,
    usernameAttribute: env.SAML_USERNAME_ATTRIBUTE ?? null,
    allowHttp: parsed.allowHttp,
  };
};

const parseSessionDays = (value: string | undefined, fail: (message: string) => void): number => {
  if (value === undefined) return DEFAULT_SESSION_DAYS;
  const days = Number(value);
  if (!/^\d+$/.test(value) || days < 1 || days > MAX_SESSION_DAYS) {
    fail(`must be a whole number of days from 1 to ${MAX_SESSION_DAYS}`);
    return DEFAULT_SESSION_DAYS;
  }
  return days;
};

export const signInSchema = envObject.transform((env, ctx): SignInConfig => {
  const user = env.NO_LOGIN_USER;
  const explicit = env.AUTH_MODE?.toLowerCase();
  const fallback: SignInConfig = { mode: 'no-login', user: '' };

  if (explicit !== undefined && explicit !== 'login' && explicit !== 'no-login') {
    refuse(ctx, 'AUTH_MODE', 'must be "login" or "no-login"');
    return fallback;
  }
  const mode =
    explicit ?? (user !== undefined ? 'no-login' : env.PUBLIC_URL !== undefined ? 'login' : null);
  if (mode === null) {
    refuse(
      ctx,
      'AUTH_MODE',
      'sets neither NO_LOGIN_USER (run without login) nor PUBLIC_URL (sign users in): set exactly one',
    );
    return fallback;
  }

  const loginOnly = Object.keys(env).filter(
    (name) => LOGIN_ONLY_NAMES.includes(name) || LOGIN_ONLY_PREFIX.test(name),
  );

  if (mode === 'no-login') {
    if (user === undefined) {
      refuse(ctx, 'NO_LOGIN_USER', 'is required when AUTH_MODE is no-login');
      return fallback;
    }
    if (/\s/.test(user) || user.length > MAX_USER_LENGTH)
      refuse(
        ctx,
        'NO_LOGIN_USER',
        `must be a name of 1 to ${MAX_USER_LENGTH} characters without whitespace`,
      );
    for (const name of loginOnly)
      refuse(
        ctx,
        name,
        'is a login setting and does nothing next to NO_LOGIN_USER: unset one side',
      );
    return { mode: 'no-login', user };
  }

  if (user !== undefined)
    refuse(ctx, 'NO_LOGIN_USER', 'switches login off and cannot be set with AUTH_MODE=login');
  if (env.PUBLIC_URL === undefined) {
    refuse(ctx, 'PUBLIC_URL', "is required to sign users in: the board's address in the browser");
    return fallback;
  }
  const url = parsePublicUrl(env.PUBLIC_URL, env.NODE_ENV === 'production', (message) =>
    refuse(ctx, 'PUBLIC_URL', message),
  );
  const passkeys = onOff(env, 'PASSKEYS', true, ctx);
  const production = env.NODE_ENV === 'production';
  const oidc = parseOidc(env, production, ctx);
  const saml = parseSaml(env, production, url?.origin ?? '', ctx);
  const allowedGroups = csv(env.ALLOWED_GROUPS);
  const signupToken = env.SIGNUP_TOKEN ?? null;
  const claimUser = env.CLAIM_USER ?? null;
  const sessionDays = parseSessionDays(env.SESSION_DAYS, (message) =>
    refuse(ctx, 'SESSION_DAYS', message),
  );

  if (allowedGroups.length > 0 && !oidc)
    refuse(ctx, 'ALLOWED_GROUPS', 'needs OIDC_ISSUER: only OIDC sends groups');
  if (allowedGroups.length > 0 && saml)
    refuse(
      ctx,
      'ALLOWED_GROUPS',
      'cannot be set with SAML_IDP_METADATA_URL: SAML sign-ins carry no groups, so the restriction would not apply to them',
    );
  if (signupToken !== null && signupToken.length < MIN_SIGNUP_TOKEN_LENGTH)
    refuse(ctx, 'SIGNUP_TOKEN', `must be at least ${MIN_SIGNUP_TOKEN_LENGTH} characters`);
  if (signupToken !== null && !passkeys)
    refuse(ctx, 'SIGNUP_TOKEN', 'needs PASSKEYS=on: an account is created with a passkey');
  if (claimUser !== null && signupToken === null)
    refuse(ctx, 'CLAIM_USER', 'needs SIGNUP_TOKEN: the account is taken over through sign-up');
  if (claimUser !== null && !SIGNUP_NAME_RULE.test(claimUser))
    refuse(
      ctx,
      'CLAIM_USER',
      'must be a sign-up name: lower case letters, digits, dots, dashes, underscores and @',
    );
  if (!passkeys && !oidc && !saml)
    refuse(
      ctx,
      'PASSKEYS',
      'no way to sign in: leave PASSKEYS on, or set OIDC_ISSUER or SAML_IDP_METADATA_URL',
    );

  return {
    mode: 'login',
    publicUrl: url?.origin ?? '',
    rpId: url?.hostname ?? '',
    scheme: url?.protocol === 'https:' ? 'https' : 'http',
    passkeys,
    signupToken,
    claimUser,
    allowedGroups,
    sessionDays,
    oidc,
    saml,
  };
});
