import { setTimeout as delay } from 'node:timers/promises';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { APP_ROLE } from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { checkApplicationRole, checkUrls } from './application-role.js';
import type { DatabaseConfig } from './config.js';
import type { Database } from './database.js';
import { migrationsFolder } from './migrations-folder.js';
import { scopedOperations } from './scoped.js';

const MIGRATION_LOCK = 7_201_001;
const ROLE_RACE_CODES = new Set(['42710', '23505']);
const ROLE_ATTEMPTS = 12;
const ROLE_RETRY_JITTER_MS = 25;
const POOL_SIZE = 10;

const roleStatement = (client: RoleClient, exists: boolean, password: string): string =>
  `${exists ? 'alter' : 'create'} role ${APP_ROLE} with login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password ${client.escapeLiteral(password)}`;

export interface RoleClient {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
  escapeLiteral(text: string): string;
}

const isRoleRace = (error: unknown): boolean => {
  const { code, message } = error as { code?: string; message?: string };
  return (
    (code !== undefined && ROLE_RACE_CODES.has(code)) ||
    (message?.includes('tuple concurrently updated') ?? false)
  );
};

export const ensureApplicationRole = async (admin: RoleClient, password: string): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    const existing = await admin.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
    try {
      await admin.query(roleStatement(admin, existing.rowCount === 1, password));
      return;
    } catch (error) {
      if (!isRoleRace(error) || attempt === ROLE_ATTEMPTS) throw error;
      await delay(Math.random() * ROLE_RETRY_JITTER_MS * attempt);
    }
  }
};

export const prepareDatabase = async (adminUrl: string, appUrl: string): Promise<void> => {
  const password = decodeURIComponent(new URL(appUrl).password);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await ensureApplicationRole(admin, password);
    await migrate(drizzle(admin), { migrationsFolder: migrationsFolder() });
    await admin.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
  } finally {
    await admin.end();
  }
};

export const openPostgresDatabase = async (
  config: Extract<DatabaseConfig, { kind: 'postgres' }>,
): Promise<Database> => {
  checkUrls(config.url, config.adminUrl);
  if (config.adminUrl !== null) await prepareDatabase(config.adminUrl, config.url);
  const pool = new pg.Pool({ connectionString: config.url, max: POOL_SIZE });
  try {
    await checkApplicationRole(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const db = drizzle(pool, { schema });
  let closing: Promise<void> | null = null;
  return {
    kind: 'postgres',
    ...scopedOperations(db, { switchRole: false, serialise: (work) => work() }),
    close: () => (closing ??= pool.end()),
  };
};
