import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import { StatementRefused, type Database } from '../../src/modules/database/index.js';
import { TARGETS, type OpenedTarget } from './targets.js';
import { rowsOf, seedUser, taskValues, wasCausedBy } from './support.js';

const pglite = TARGETS.find((target) => target.name === 'pglite');
if (pglite === undefined) throw new Error('the PGlite target is missing');

const ESCAPES = [
  'reset role',
  'RESET   ROLE',
  'reset\nrole',
  'reset/**/role',
  'reset -- hidden\nrole',
  'reset "role"',
  'set role postgres',
  'set local role postgres',
  'set session role postgres',
  'set "role" to postgres',
  'set"role"to postgres',
  "set local app.owner to 'bob'",
  'set local "app"."owner" = \'bob\'',
  'reset app.owner',
  'set session authorization postgres',
  'reset session authorization',
  "select set_config('role', 'postgres', true)",
  "select set_config('app.owner', 'bob', true)",
  'select 1; reset role',
  'reset all',
  'discard all',
  'set local row_security = off',
  "do $$ begin execute 'reset role'; end $$",
  "do 'begin end'",
  'reset U&"\\0072ole"',
];

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder).flatMap((entry) => {
    const path = join(folder, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('row isolation under PGlite', () => {
  let opened: OpenedTarget;
  let database: Database;

  beforeAll(async () => {
    opened = await pglite.open();
    database = opened.database;
    const alice = await seedUser(database, 'alice');
    await seedUser(database, 'bob');
    await database.withOwner('alice', (tx) =>
      tx.insert(schema.task).values(taskValues(alice.projectId, 't-alice')),
    );
  });

  afterAll(async () => {
    await opened.cleanup();
  });

  it('[api-016] the session is a superuser underneath and every request still runs as the application role', async () => {
    const facts = await database.withOwner('alice', (tx) =>
      rowsOf(tx, sql`select current_user as effective, session_user as session`),
    );
    expect(facts[0]?.effective).toBe('board_app');
    expect(facts[0]?.session).not.toBe('board_app');
    expect(await database.withOwner('bob', (tx) => tx.select().from(schema.task))).toEqual([]);
  });

  it.each(ESCAPES)('[api-016] the driver refuses the statement %j', async (text) => {
    expect(
      await wasCausedBy(
        database.withOwner('bob', (tx) => tx.execute(sql.raw(text))),
        StatementRefused,
      ),
    ).toBe(true);
    const after = await database.withOwner('bob', (tx) =>
      rowsOf(
        tx,
        sql`select current_user as effective, current_setting('app.owner', true) as owner`,
      ),
    );
    expect(after[0]).toMatchObject({ effective: 'board_app', owner: 'bob' });
    expect(await database.withOwner('bob', (tx) => tx.select().from(schema.task))).toEqual([]);
  });

  it('[api-016] a refused statement in a request fails the request and writes nothing', async () => {
    expect(
      await wasCausedBy(
        database.withOwner('bob', async (tx) => {
          await tx.insert(schema.project).values({ position: 5 });
          await tx.execute(sql.raw('reset role'));
        }),
        StatementRefused,
      ),
    ).toBe(true);
    const projects = await database.withOwner('bob', (tx) => tx.select().from(schema.project));
    expect(projects.map((row) => row.position)).not.toContain(5);
  });

  it('[api-016] the database handle exposes scoped work only, never a raw client', () => {
    expect(Object.keys(database).sort()).toEqual([
      'close',
      'kind',
      'vacuum',
      'withOwner',
      'withOwners',
      'withSystem',
    ]);
  });

  it('[api-016] no request path takes SQL text: only the database layer touches a driver or raw SQL', () => {
    const allowed = [join('src', 'db'), join('src', 'modules', 'database')];
    const offenders = sourceFiles('src')
      .filter((file) => !allowed.some((folder) => file.startsWith(folder)))
      .filter((file) =>
        /sql\.raw\(|\.execute\(|\.query\(|from 'pg'|@electric-sql\/pglite/.test(
          readFileSync(file, 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
