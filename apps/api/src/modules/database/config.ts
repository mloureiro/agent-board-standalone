import { envObject, refuse } from '../env.js';

export type DatabaseKind = 'postgres' | 'pglite';

export type DatabaseConfig =
  { kind: 'postgres'; url: string; adminUrl: string | null } | { kind: 'pglite'; dataDir: string };

const POSTGRES_SCHEME = /^postgres(?:ql)?:\/\//;
const PGLITE_SCHEME = 'pglite://';

export const databaseSchema = envObject.transform((env, ctx): DatabaseConfig => {
  const url = env.DATABASE_URL;
  const adminUrl = env.DATABASE_ADMIN_URL ?? null;
  const invalid = { kind: 'pglite', dataDir: '' } satisfies DatabaseConfig;
  if (url === undefined) {
    refuse(ctx, 'DATABASE_URL', 'is required: postgres://… or pglite://<directory>');
    return invalid;
  }
  if (url.startsWith(PGLITE_SCHEME)) {
    const dataDir = url.slice(PGLITE_SCHEME.length);
    if (dataDir === '') refuse(ctx, 'DATABASE_URL', 'pglite:// needs a directory');
    if (adminUrl !== null)
      refuse(
        ctx,
        'DATABASE_ADMIN_URL',
        'applies to Postgres only: unset it with a pglite:// database',
      );
    return { kind: 'pglite', dataDir };
  }
  if (POSTGRES_SCHEME.test(url)) {
    if (adminUrl !== null && !POSTGRES_SCHEME.test(adminUrl))
      refuse(ctx, 'DATABASE_ADMIN_URL', 'must be a postgres:// URL');
    return { kind: 'postgres', url, adminUrl };
  }
  refuse(ctx, 'DATABASE_URL', 'must start with postgres:// or pglite://');
  return invalid;
});
