import type { SignInMethod } from '@agent-board/contract';

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
  allowedGroups: string[];
  oidc: boolean;
  saml: boolean;
}

export type SignInConfig = NoLoginConfig | LoginConfig;

export const MIN_SIGNUP_TOKEN_LENGTH = 32;
const MAX_USER_LENGTH = 128;
const LOGIN_ONLY_NAMES = [
  'PUBLIC_URL',
  'PASSKEYS',
  'SIGNUP_TOKEN',
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
  const oidc = env.OIDC_ISSUER !== undefined;
  const saml = env.SAML_ENTRY_POINT !== undefined;
  const allowedGroups = csv(env.ALLOWED_GROUPS);
  const signupToken = env.SIGNUP_TOKEN ?? null;

  if (allowedGroups.length > 0 && !oidc)
    refuse(ctx, 'ALLOWED_GROUPS', 'needs OIDC_ISSUER: only OIDC sends groups');
  if (signupToken !== null && signupToken.length < MIN_SIGNUP_TOKEN_LENGTH)
    refuse(ctx, 'SIGNUP_TOKEN', `must be at least ${MIN_SIGNUP_TOKEN_LENGTH} characters`);
  if (signupToken !== null && !passkeys)
    refuse(ctx, 'SIGNUP_TOKEN', 'needs PASSKEYS=on: an account is created with a passkey');
  if (!passkeys && !oidc && !saml)
    refuse(
      ctx,
      'PASSKEYS',
      'no way to sign in: leave PASSKEYS on, or set OIDC_ISSUER or SAML_ENTRY_POINT',
    );

  return {
    mode: 'login',
    publicUrl: url?.origin ?? '',
    rpId: url?.hostname ?? '',
    scheme: url?.protocol === 'https:' ? 'https' : 'http',
    passkeys,
    signupToken,
    allowedGroups,
    oidc,
    saml,
  };
});
