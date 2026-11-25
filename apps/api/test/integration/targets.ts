import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import {
  openPgliteDatabase,
  openPostgresDatabase,
  type Database,
} from '../../src/modules/database/index.js';

export const POSTGRES_URL = process.env.API_TEST_POSTGRES_URL ?? process.env.E2E_POSTGRES_URL;

export const APP_PASSWORD = 'integration-test-password';

export interface OpenedTarget {
  readonly kind: 'pglite' | 'postgres';
  readonly database: Database;
  readonly dataDir: string | null;
  readonly adminUrl: string | null;
  readonly appUrl: string | null;
  cleanup(): Promise<void>;
}

export interface Target {
  readonly name: 'pglite' | 'postgres';
  readonly enabled: boolean;
  open(): Promise<OpenedTarget>;
}

export interface PostgresDatabase {
  readonly name: string;
  readonly adminUrl: string;
  readonly appUrl: string;
  drop(): Promise<void>;
}

export const createPostgresDatabase = async (): Promise<PostgresDatabase> => {
  const base = POSTGRES_URL;
  if (base === undefined) throw new Error('no Postgres URL is configured for the tests');
  const name = `it_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: base });
  await root.connect();
  try {
    await root.query(`create database "${name}"`);
  } finally {
    await root.end();
  }
  const adminUrl = new URL(base);
  adminUrl.pathname = `/${name}`;
  const appUrl = new URL(adminUrl);
  appUrl.username = 'board_app';
  appUrl.password = APP_PASSWORD;
  return {
    name,
    adminUrl: adminUrl.toString(),
    appUrl: appUrl.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: base });
      await client.connect();
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
};

const pgliteTarget: Target = {
  name: 'pglite',
  enabled: true,
  open: async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'board-api-it-'));
    const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
    return {
      kind: 'pglite',
      database,
      dataDir,
      adminUrl: null,
      appUrl: null,
      cleanup: async () => {
        await database.close();
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  },
};

const postgresTarget: Target = {
  name: 'postgres',
  enabled: POSTGRES_URL !== undefined,
  open: async () => {
    const created = await createPostgresDatabase();
    const database = await openPostgresDatabase({
      kind: 'postgres',
      url: created.appUrl,
      adminUrl: created.adminUrl,
    });
    return {
      kind: 'postgres',
      database,
      dataDir: null,
      adminUrl: created.adminUrl,
      appUrl: created.appUrl,
      cleanup: async () => {
        await database.close();
        await created.drop();
      },
    };
  },
};

export const TARGETS: readonly Target[] = [pgliteTarget, postgresTarget];
