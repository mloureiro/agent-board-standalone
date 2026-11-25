import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import type { Insert } from './content.js';

const run = promisify(execFile);
const SECTION_BREAK = '--> statement-breakpoint';
const POSTGRES_IMAGE = 'postgres:16';
const SERVER_PASSWORD = 'fixture';
const DUMP_FLAGS = [
  '--no-owner',
  '--no-acl',
  '--no-comments',
  '--column-inserts',
  '--no-publications',
  '--no-subscriptions',
];

export interface PostgresServer {
  readonly adminUrl: string;
  dump(database: string): Promise<string>;
  stop(): Promise<void>;
}

export interface Migration {
  readonly tag: string;
  readonly when: number;
  readonly sql: string;
}

export interface ApplyReport {
  readonly skippedTables: readonly string[];
  readonly droppedColumns: readonly string[];
}

const withDatabase = (adminUrl: string, database: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

async function connectWithRetry(url: string): Promise<pg.Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export async function startServer(options: {
  postgresUrl?: string | undefined;
  pgDump: string;
}): Promise<PostgresServer> {
  if (options.postgresUrl !== undefined) {
    const adminUrl = options.postgresUrl;
    return {
      adminUrl,
      async dump(database) {
        const { stdout } = await run(
          options.pgDump,
          [...DUMP_FLAGS, `--dbname=${withDatabase(adminUrl, database)}`],
          { maxBuffer: 256 * 1024 * 1024 },
        );
        return stdout;
      },
      async stop() {},
    };
  }
  const { stdout: started } = await run('docker', [
    'run',
    '--detach',
    '--rm',
    '--env',
    `POSTGRES_PASSWORD=${SERVER_PASSWORD}`,
    '--publish',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ]);
  const container = started.trim();
  const { stdout: mapping } = await run('docker', ['port', container, '5432/tcp']);
  const port = mapping.trim().split('\n')[0]?.split(':').at(-1);
  if (port === undefined) throw new Error('The Postgres container published no port');
  const adminUrl = `postgres://postgres:${SERVER_PASSWORD}@127.0.0.1:${port}/postgres`;
  const probe = await connectWithRetry(adminUrl);
  await probe.end();
  return {
    adminUrl,
    async dump(database) {
      const { stdout } = await run(
        'docker',
        ['exec', container, 'pg_dump', '--username=postgres', ...DUMP_FLAGS, database],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      return stdout;
    },
    async stop() {
      await run('docker', ['stop', container]);
    },
  };
}

const git = async (core: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await run('git', [...args], { cwd: core, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

export async function readMigrations(core: string, commit: string): Promise<Migration[]> {
  const journal = JSON.parse(
    await git(core, ['show', `${commit}:apps/backend/drizzle/meta/_journal.json`]),
  ) as { entries: { tag: string; when: number }[] };
  return Promise.all(
    journal.entries.map(async ({ tag, when }) => ({
      tag,
      when,
      sql: await git(core, ['show', `${commit}:apps/backend/drizzle/${tag}.sql`]),
    })),
  );
}

export async function createDatabase(
  server: PostgresServer,
  database: string,
): Promise<{ url: string; client: pg.Client }> {
  const admin = await connectWithRetry(server.adminUrl);
  try {
    await admin.query(`drop database if exists "${database}"`);
    await admin.query(`create database "${database}"`);
    await admin.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'board_app') then
          create role board_app nologin nosuperuser nobypassrls;
        end if;
      end $$`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(server.adminUrl, database);
  return { url, client: await connectWithRetry(url) };
}

export async function applyMigrations(
  client: pg.Client,
  migrations: readonly Migration[],
): Promise<void> {
  await client.query('create schema if not exists drizzle');
  await client.query(
    'create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
  );
  for (const migration of migrations) {
    await client.query('begin');
    try {
      for (const statement of migration.sql.split(SECTION_BREAK)) await client.query(statement);
      await client.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [createHash('sha256').update(migration.sql).digest('hex'), migration.when],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(`Migration ${migration.tag} failed`, { cause: error });
    }
  }
}

export async function insertContent(
  client: pg.Client,
  inserts: readonly Insert[],
): Promise<ApplyReport> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  );
  const columns = new Map<string, Set<string>>();
  for (const { table_name, column_name } of rows) {
    const known = columns.get(table_name) ?? new Set<string>();
    known.add(column_name);
    columns.set(table_name, known);
  }
  const skippedTables = new Set<string>();
  const droppedColumns = new Set<string>();
  for (const { table, row } of inserts) {
    const known = columns.get(table);
    if (known === undefined) {
      skippedTables.add(table);
      continue;
    }
    const names: string[] = [];
    const values: unknown[] = [];
    for (const [name, value] of Object.entries(row)) {
      if (known.has(name)) {
        names.push(name);
        values.push(value);
      } else if (value !== null && value !== undefined) droppedColumns.add(`${table}.${name}`);
    }
    await client.query(
      `insert into "${table}" (${names.map((name) => `"${name}"`).join(', ')}) values (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
      values,
    );
  }
  return { skippedTables: [...skippedTables].sort(), droppedColumns: [...droppedColumns].sort() };
}

export function normaliseDump(dump: string): string {
  return (
    dump
      .split('\n')
      .filter((line) => !line.startsWith('\\restrict ') && !line.startsWith('\\unrestrict '))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
