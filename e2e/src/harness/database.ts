import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

import { POSTGRES_URL_VARIABLE } from './paths.js';
import type { Tmp } from './tmp.js';

export type DatabaseKind = 'postgres' | 'pglite';

export interface Database {
  readonly kind: DatabaseKind;
  readonly name: string;
  readonly adminUrl: string | null;
  readonly appUrl: string;
  readonly dataDir: string;
  drop(): Promise<void>;
}

export interface DatabaseEnv {
  readonly DATABASE_URL: string;
  readonly DATABASE_ADMIN_URL?: string;
}

export const APP_ROLE = 'board_app';
const LOCK_STALE_MS = 120_000;
const LOCK_POLL_MS = 100;

export function databaseEnv(database: Database): DatabaseEnv {
  return database.adminUrl === null
    ? { DATABASE_URL: database.appUrl }
    : { DATABASE_URL: database.appUrl, DATABASE_ADMIN_URL: database.adminUrl };
}

export function appRolePassword(env: NodeJS.ProcessEnv = process.env): string {
  const fixed = env.E2E_APP_ROLE_PASSWORD;
  if (fixed) return fixed;
  return createHash('sha256')
    .update(`agent-board-e2e|${env[POSTGRES_URL_VARIABLE] ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function createPgliteDatabase(tmp: Tmp): Database {
  const dataDir = tmp.path('db');
  mkdirSync(dataDir, { recursive: true });
  return {
    kind: 'pglite',
    name: 'pglite',
    adminUrl: null,
    appUrl: `pglite://${dataDir}`,
    dataDir,
    drop: async () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createPostgresDatabase(
  tmp: Tmp,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Database> {
  const base = env[POSTGRES_URL_VARIABLE];
  if (!base) throw new Error(`${POSTGRES_URL_VARIABLE} is not set`);
  const name = `e2e_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const adminUrl = new URL(base);
  adminUrl.pathname = `/${name}`;
  const appUrl = new URL(adminUrl);
  appUrl.username = APP_ROLE;
  appUrl.password = appRolePassword(env);
  return {
    kind: 'postgres',
    name,
    adminUrl: adminUrl.toString(),
    appUrl: appUrl.toString(),
    dataDir: tmp.path('db'),
    drop: async () => {
      const client = new pg.Client({ connectionString: base });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

export async function createDatabase(
  kind: DatabaseKind,
  tmp: Tmp,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Database> {
  return kind === 'postgres' ? createPostgresDatabase(tmp, env) : createPgliteDatabase(tmp);
}

export const POSTGRES_START_LOCK = path.join(os.tmpdir(), 'agent-board-e2e-postgres-start.lock');

async function acquire(lockFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx');
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const age = await stat(lockFile).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age > LOCK_STALE_MS) {
      await rm(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockFile}`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

export async function withStartLock<T>(
  work: () => Promise<T>,
  lockFile: string = POSTGRES_START_LOCK,
  timeoutMs = 120_000,
): Promise<T> {
  await acquire(lockFile, timeoutMs);
  try {
    return await work();
  } finally {
    await rm(lockFile, { force: true });
  }
}
