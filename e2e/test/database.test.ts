import pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  appRolePassword,
  createDatabase,
  createPgliteDatabase,
  databaseEnv,
  withStartLock,
} from '../src/harness/database.js';
import { createTmp } from '../src/harness/tmp.js';

describe('PGlite database', () => {
  it('points DATABASE_URL at <tmp>/db and has no admin URL', () => {
    const tmp = createTmp('db-test');
    const database = createPgliteDatabase(tmp);
    expect(database.appUrl).toBe(`pglite://${tmp.path('db')}`);
    expect(databaseEnv(database)).toEqual({ DATABASE_URL: database.appUrl });
    tmp.remove();
  });
});

describe('start lock', () => {
  it('serialises work', async () => {
    const tmp = createTmp('lock-test');
    const lock = tmp.path('lock');
    const order: string[] = [];
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => (entered = resolve));
    const first = withStartLock(async () => {
      order.push('a-start');
      entered();
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('a-end');
    }, lock);
    await firstEntered;
    const second = withStartLock(async () => {
      order.push('b-start');
    }, lock);
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    tmp.remove();
  });
});

describe('app role password', () => {
  it('is stable for one server and honours an explicit value', () => {
    const env = { E2E_POSTGRES_URL: 'postgres://localhost/postgres' };
    expect(appRolePassword(env)).toBe(appRolePassword(env));
    expect(appRolePassword({ ...env, E2E_APP_ROLE_PASSWORD: 'fixed' })).toBe('fixed');
  });
});

describe.skipIf(!process.env.E2E_POSTGRES_URL)('Postgres database', () => {
  it('creates and drops an e2e_<random> database', async () => {
    const tmp = createTmp('pg-test');
    const database = await createDatabase('postgres', tmp);
    expect(database.name).toMatch(/^e2e_[0-9a-f]{12}$/);
    expect(new URL(database.adminUrl as string).pathname).toBe(`/${database.name}`);
    expect(new URL(database.appUrl).username).toBe('board_app');

    const exists = async () => {
      const client = new pg.Client({ connectionString: process.env.E2E_POSTGRES_URL });
      await client.connect();
      try {
        const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          database.name,
        ]);
        return result.rowCount === 1;
      } finally {
        await client.end();
      }
    };
    expect(await exists()).toBe(true);
    await database.drop();
    expect(await exists()).toBe(false);
    tmp.remove();
  });
});
