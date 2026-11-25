import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import { checkApplicationRole } from '../../src/modules/database/application-role.js';
import {
  DatabaseRefusal,
  openDatabase,
  openPgliteDatabase,
  openPostgresDatabase,
  type Database,
} from '../../src/modules/database/index.js';
import { startServer } from '../../src/start.js';
import {
  APP_PASSWORD,
  POSTGRES_URL,
  TARGETS,
  createPostgresDatabase,
  type PostgresDatabase,
} from './targets.js';
import { envelope, rowsOf, seedUser } from './support.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'previous-release');
const postgresEnabled = POSTGRES_URL !== undefined;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'board-api-driver-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const postgresDatabase = async (): Promise<PostgresDatabase> => {
  const created = await createPostgresDatabase();
  cleanups.push(created.drop);
  return created;
};

const withUser = (url: string, user: string, password: string | null): string => {
  const next = new URL(url);
  next.username = user;
  next.password = password ?? '';
  return next.toString();
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseRefusal);
    return (error as DatabaseRefusal).message;
  }
  throw new Error('the database was opened');
};

describe('the application role and the two URLs', () => {
  it.skipIf(!postgresEnabled)(
    '[api-001] the admin URL creates the role and runs the migrations, and every request runs on the application URL',
    async () => {
      const created = await postgresDatabase();
      const database = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      });
      cleanups.push(() => database.close());
      const who = await database.withOwner('someone', (tx) =>
        rowsOf(tx, sql`select current_user as role, session_user as session`),
      );
      expect(who[0]).toEqual({ role: 'board_app', session: 'board_app' });

      const admin = new pg.Client({ connectionString: created.adminUrl });
      await admin.connect();
      try {
        const role = await admin.query(
          'select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = $1',
          ['board_app'],
        );
        expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
        const owners = await admin.query(
          "select distinct tableowner from pg_tables where schemaname = 'public'",
        );
        expect(owners.rows.map((row: { tableowner: string }) => row.tableowner)).not.toContain(
          'board_app',
        );
        await admin.query(`alter role board_app password 'stale'`);
      } finally {
        await admin.end();
      }
      await database.close();
      const reopened = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      });
      cleanups.push(() => reopened.close());
      await seedUser(reopened, 'again');
    },
  );

  it.skipIf(!postgresEnabled)(
    '[api-001] without an admin URL the server serves a database that is already migrated and refuses one that is not',
    async () => {
      const created = await postgresDatabase();
      const first = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      });
      await first.close();
      const served = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: null,
      });
      cleanups.push(() => served.close());
      await seedUser(served, 'no-admin');

      const empty = await postgresDatabase();
      const setup = new pg.Client({ connectionString: empty.adminUrl });
      await setup.connect();
      await setup.query(
        `do $$ begin if not exists (select from pg_roles where rolname = 'board_app') then create role board_app login password '${APP_PASSWORD}'; end if; end $$`,
      );
      await setup.end();
      const message = await refusal(
        openPostgresDatabase({ kind: 'postgres', url: empty.appUrl, adminUrl: null }),
      );
      expect(message).toContain('not migrated');
    },
  );

  it.skipIf(!postgresEnabled)(
    '[api-002] the start is refused for the wrong role, no password or the admin user',
    async () => {
      const created = await postgresDatabase();
      const wrongUser = await refusal(
        openPostgresDatabase({
          kind: 'postgres',
          url: withUser(created.appUrl, 'someone_else', 'secret'),
          adminUrl: created.adminUrl,
        }),
      );
      expect(wrongUser).toContain('"board_app"');
      const noPassword = await refusal(
        openPostgresDatabase({
          kind: 'postgres',
          url: withUser(created.appUrl, 'board_app', null),
          adminUrl: created.adminUrl,
        }),
      );
      expect(noPassword).toContain('password');
      const sameUser = await refusal(
        openPostgresDatabase({
          kind: 'postgres',
          url: created.appUrl,
          adminUrl: withUser(created.adminUrl, 'board_app', APP_PASSWORD),
        }),
      );
      expect(sameUser).toContain('different user');
    },
  );

  it.skipIf(!postgresEnabled)(
    '[api-002] the start is refused when the application role is a superuser, bypasses row security or owns a table',
    async () => {
      const created = await postgresDatabase();
      const opened = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      });
      await opened.close();
      const admin = new pg.Client({ connectionString: created.adminUrl });
      await admin.connect();
      const suffix = randomBytes(4).toString('hex');
      const roles = {
        superuser: `abt_super_${suffix}`,
        bypass: `abt_bypass_${suffix}`,
        owner: `abt_owner_${suffix}`,
        fine: `abt_fine_${suffix}`,
      };
      await admin.query(`create role ${roles.superuser} login superuser password 'x'`);
      await admin.query(`create role ${roles.bypass} login bypassrls password 'x'`);
      await admin.query(`create role ${roles.owner} login password 'x'`);
      await admin.query(`create role ${roles.fine} login password 'x'`);
      await admin.query(`grant all on schema public to ${roles.owner}`);
      await admin.query(`set role ${roles.owner}`);
      await admin.query('create table owned_by_app (id int)');
      await admin.query('reset role');
      try {
        const problems = async (role: string, expected: string = role): Promise<string> => {
          const pool = new pg.Pool({ connectionString: withUser(created.adminUrl, role, 'x') });
          try {
            await checkApplicationRole(pool, expected);
            return '';
          } catch (error) {
            return (error as DatabaseRefusal).message;
          } finally {
            await pool.end();
          }
        };
        expect(await problems(roles.superuser)).toContain('superuser');
        expect(await problems(roles.bypass)).toContain('bypasses row-level security');
        expect(await problems(roles.owner)).toContain('owns a table');
        expect(await problems(roles.fine)).toBe('');
        expect(await problems(roles.fine, 'board_app')).toContain('not "board_app"');
      } finally {
        await admin.query('drop table owned_by_app');
        await admin.query(`drop owned by ${roles.owner}`);
        for (const role of Object.values(roles)) await admin.query(`drop role ${role}`);
        await admin.end();
      }
    },
  );
});

describe('one module choice by configuration', () => {
  it('[api-015] a PGlite URL runs the whole server in-process with migrations applied and rows isolated', async () => {
    const dataDir = tempDir();
    const lines: string[] = [];
    const started = await startServer(
      { NO_LOGIN_USER: 'owner', DATABASE_URL: `pglite://${join(dataDir, 'db')}`, PORT: '0' },
      { write: (line) => lines.push(line) },
    );
    const answer = await fetch(`${started.url}/healthz`);
    expect(answer.status).toBe(200);
    expect(lines.join('')).toContain('listening');
    await started.close();

    const database = await openDatabase({ kind: 'pglite', dataDir: join(dataDir, 'db') });
    cleanups.push(() => database.close());
    expect(database.kind).toBe('pglite');
    const tables = await database.withOwner('x', (tx) =>
      rowsOf(tx, sql`select count(*)::int as count from pg_tables where schemaname = 'public'`),
    );
    expect(Number(tables[0]?.count)).toBeGreaterThanOrEqual(17);
    await seedUser(database, 'alice');
    expect(await database.withOwner('bob', (tx) => tx.select().from(schema.appUser))).toEqual([]);
  });

  it.each(TARGETS.filter((target) => target.enabled))(
    '[api-015] the $name driver is chosen by the URL scheme alone',
    async (target) => {
      const opened = await target.open();
      cleanups.push(opened.cleanup);
      expect(opened.database.kind).toBe(target.name);
      await seedUser(opened.database, 'scheme');
      const mine = await opened.database.withOwner('scheme', (tx) =>
        tx.select().from(schema.project),
      );
      expect(mine).toHaveLength(1);
    },
  );
});

describe('upgrade from the previous release', () => {
  const seedPreviousRelease = async (run: (statement: string) => Promise<unknown>) => {
    await run(`insert into app_user (username) values ('legacy')`);
    await run(
      `insert into project (owner, id, is_default) values ('legacy', '00000000-0000-4000-8000-000000000001', true)`,
    );
    await run(
      `insert into machine (owner, id, token_hash) values ('legacy', 'old-laptop', '${'7'.repeat(64)}')`,
    );
    await run(
      `insert into task (owner, id, title, input, position, project_id) values ('legacy', 'old-task', '${envelope()}', '${envelope()}', 1, '00000000-0000-4000-8000-000000000001')`,
    );
  };

  const expectUpgraded = async (database: Database) => {
    const tasks = await database.withOwner('legacy', (tx) => tx.select().from(schema.task));
    expect(tasks.map((row) => row.id)).toEqual(['old-task']);
    const machine = await database.withSystem((system) => system.lookupMachine('7'.repeat(64)));
    expect(machine).toMatchObject({ owner: 'legacy', machineId: 'old-laptop' });
    const constraints = await database.withOwner('legacy', (tx) =>
      rowsOf(
        tx,
        sql`select conname from pg_constraint where conname in ('task_directory_fk', 'task_parent_fk')`,
      ),
    );
    expect(constraints).toHaveLength(2);
    await database.withOwner('legacy', async (tx) => {
      await tx.insert(schema.task).values({
        id: 'upgraded-task',
        title: envelope(),
        input: envelope(),
        position: 2,
        projectId: '00000000-0000-4000-8000-000000000001',
        watchStops: Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(16, '0')),
      });
    });
  };

  it('[api-018] a PGlite database written by the previous release migrates and keeps its rows', async () => {
    const dataDir = join(tempDir(), 'db');
    const previous = await PGlite.create(dataDir);
    await previous.exec('create role board_app nologin');
    await migratePglite(drizzlePglite(previous), { migrationsFolder: FIXTURE });
    await seedPreviousRelease((statement) => previous.exec(statement));
    await previous.close();

    const database = await openPgliteDatabase({ kind: 'pglite', dataDir });
    cleanups.push(() => database.close());
    await expectUpgraded(database);
  });

  it.skipIf(!postgresEnabled)(
    '[api-018] a Postgres database written by the previous release migrates and keeps its rows',
    async () => {
      const created = await postgresDatabase();
      const admin = new pg.Client({ connectionString: created.adminUrl });
      await admin.connect();
      try {
        await admin.query(
          `do $$ begin if not exists (select from pg_roles where rolname = 'board_app') then create role board_app login password '${APP_PASSWORD}'; end if; end $$`,
        );
        await migratePg(drizzlePg(admin), { migrationsFolder: FIXTURE });
        await seedPreviousRelease((statement) => admin.query(statement));
      } finally {
        await admin.end();
      }
      const database = await openPostgresDatabase({
        kind: 'postgres',
        url: created.appUrl,
        adminUrl: created.adminUrl,
      });
      cleanups.push(() => database.close());
      await expectUpgraded(database);
    },
  );
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
