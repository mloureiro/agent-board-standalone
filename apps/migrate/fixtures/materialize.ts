import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PGlite as Pglite16 } from 'pglite-0-5-16';
import { PGlite as Pglite17 } from 'pglite-0-5-17';
import { fixtureSpec, sqlPath, type PgliteAlias } from './fixtures.js';

export interface QueryableDatabase {
  query<Row extends object>(sql: string): Promise<Row[]>;
  close(): Promise<void>;
}

const CREATE_APP_ROLE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'board_app') then
      create role board_app nologin nosuperuser nobypassrls;
    end if;
  end $$;
`;

type PgliteConstructor = typeof Pglite17;

const PGLITE_BY_ALIAS: Readonly<Record<PgliteAlias, PgliteConstructor>> = {
  'pglite-0-5-16': Pglite16 as unknown as PgliteConstructor,
  'pglite-0-5-17': Pglite17,
};

export const readFixtureSql = (name: string): Promise<string> =>
  readFile(sqlPath(fixtureSpec(name).name), 'utf8');

function wrap(database: InstanceType<PgliteConstructor>): QueryableDatabase {
  return {
    async query<Row extends object>(sql: string) {
      return (await database.query<Row>(sql)).rows;
    },
    close: () => database.close(),
  };
}

export async function openPglite(
  dataDirectory: string,
  alias: PgliteAlias,
): Promise<QueryableDatabase> {
  const database = new PGLITE_BY_ALIAS[alias](dataDirectory);
  await database.waitReady;
  return wrap(database);
}

export async function materializePglite(
  name: string,
  dataDirectory: string,
  alias: PgliteAlias = fixtureSpec(name).pglite,
): Promise<QueryableDatabase> {
  const database = new PGLITE_BY_ALIAS[alias](dataDirectory);
  await database.waitReady;
  try {
    await database.exec(CREATE_APP_ROLE);
    await database.exec(await readFixtureSql(name));
    await database.exec('reset search_path');
  } catch (error) {
    await database.close();
    throw error;
  }
  return wrap(database);
}

export interface PostgresMaterialization {
  readonly url: string;
  drop(): Promise<void>;
}

export async function materializePostgres(
  adminUrl: string,
  name: string,
): Promise<PostgresMaterialization> {
  const database = `fixture_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(CREATE_APP_ROLE);
  await admin.query(`create database "${database}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    await client.query(await readFixtureSql(name));
    await client.query('reset search_path');
  } catch (error) {
    await client.end().catch(() => undefined);
    await admin.query(`drop database "${database}"`).catch(() => undefined);
    await admin.end();
    throw error;
  }
  await client.end();
  return {
    url: url.toString(),
    async drop() {
      await admin.query(`drop database "${database}" with (force)`);
      await admin.end();
    },
  };
}

export const SOURCE_TABLES = [
  'app_user',
  'machine',
  'task',
  'schedule',
  'note',
  'task_pr',
  'transcript_run',
  'transcript_event',
  'passkey',
  'shared_agents',
  'link_rules',
  'title_rules',
] as const;
