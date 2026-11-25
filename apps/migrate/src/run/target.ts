import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RunRefusal } from './errors.js';

export type TargetDatabase =
  { readonly kind: 'pglite'; readonly directory: string } | { readonly kind: 'postgres' };

const PGLITE_SCHEME = 'pglite://';
const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const PGLITE_LOCK_FILE = 'postmaster.pid';

export function parseTarget(url: string): TargetDatabase {
  if (url.startsWith(PGLITE_SCHEME)) {
    const directory = url.slice(PGLITE_SCHEME.length);
    if (directory === '') throw new RunRefusal('--target-db pglite:// needs a directory');
    return { kind: 'pglite', directory };
  }
  if (POSTGRES_URL.test(url)) return { kind: 'postgres' };
  throw new RunRefusal('--target-db must start with postgres:// or pglite://');
}

export function refuseHeldTarget(target: TargetDatabase): void {
  if (target.kind !== 'pglite') return;
  if (existsSync(join(target.directory, PGLITE_LOCK_FILE)))
    throw new RunRefusal(
      `the target folder holds ${PGLITE_LOCK_FILE}: another process has it open, or one stopped without closing it. Stop that process (a PGlite folder has one process at a time) and run again`,
    );
}

export type SignInRule =
  { readonly mode: 'no-login'; readonly user: string } | { readonly mode: 'login' };

type Env = Readonly<Record<string, string | undefined>>;

const trimmed = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === '' ? undefined : value;
};

export function signInRuleOf(env: Env): SignInRule {
  const user = trimmed(env, 'NO_LOGIN_USER');
  const explicit = trimmed(env, 'AUTH_MODE')?.toLowerCase();
  if (explicit !== undefined && explicit !== 'login' && explicit !== 'no-login')
    throw new RunRefusal('AUTH_MODE must be "login" or "no-login"');
  const mode =
    explicit ??
    (user !== undefined ? 'no-login' : trimmed(env, 'PUBLIC_URL') !== undefined ? 'login' : null);
  if (mode === 'login') return { mode };
  if (mode === 'no-login' && user !== undefined) return { mode, user };
  if (mode === 'no-login')
    throw new RunRefusal('NO_LOGIN_USER is required when AUTH_MODE is no-login');
  throw new RunRefusal(
    'the target sets neither NO_LOGIN_USER (no login) nor PUBLIC_URL (login): set exactly one in the environment',
  );
}

export function checkOwners(owners: readonly string[], rule: SignInRule): string {
  if (owners.length === 0) throw new RunRefusal('the source holds no owner to migrate');
  if (rule.mode === 'login') return `owner check: login target, owners ${owners.join(', ')}`;
  const others = owners.filter((owner) => owner !== rule.user);
  if (others.length > 0)
    throw new RunRefusal(
      `the exported owner ${others.map((owner) => `"${owner}"`).join(', ')} is not the NO_LOGIN_USER "${rule.user}": content keys derive from the owner name, so a different name would open nothing. Set the target's user name to the exported owner`,
    );
  return `owner check: ok, "${rule.user}" is the NO_LOGIN_USER`;
}

export function importEnv(
  env: Readonly<Record<string, string | undefined>>,
  target: TargetDatabase,
  targetDb: string,
): Record<string, string | undefined> {
  if (target.kind === 'pglite') {
    return { ...env, DATABASE_URL: targetDb, DATABASE_ADMIN_URL: undefined };
  }
  const appUrl = trimmed(env, 'DATABASE_URL');
  if (appUrl === undefined || !POSTGRES_URL.test(appUrl))
    throw new RunRefusal(
      'a Postgres target needs DATABASE_URL in the environment: the application-role (board_app) URL the server will use. --target-db is the admin URL that prepares it',
    );
  return { ...env, DATABASE_URL: appUrl, DATABASE_ADMIN_URL: targetDb };
}
