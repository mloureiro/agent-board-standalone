import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bindings,
  decodeDataKey,
  deriveKeys,
  isBlindIndex,
  isEnvelope,
  open,
  tokenHash,
  unlockKeys,
  type KeySlot,
} from '@agent-board/sealing';
import { FIXTURES, PGLITE_BUILDS } from '../fixtures/fixtures.js';
import {
  materializePglite,
  materializePostgres,
  openPglite,
  type QueryableDatabase,
} from '../fixtures/materialize.js';
import {
  COUNTED_TABLES,
  SEALED_COLUMNS,
  readCredentials,
  readReadme,
  readmeCounts,
} from './support/fixture-files.js';

describe.each(FIXTURES)('fixture $name', (fixture) => {
  let scratch: string;
  let dataDirectory: string;
  let database: QueryableDatabase;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), `fixture-test-${fixture.name}-`));
    dataDirectory = join(scratch, 'data');
    database = await materializePglite(fixture.name, dataDirectory);
  });

  afterAll(async () => {
    await database.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  });

  it('writes the PG_VERSION and server version recorded for its PGlite build', async () => {
    const build = PGLITE_BUILDS[fixture.pglite];
    expect((await readFile(join(dataDirectory, 'PG_VERSION'), 'utf8')).trim()).toBe(
      build.pgVersionFile,
    );
    const [{ version }] = (await database.query<{ version: string }>(
      'select version() as version',
    )) as [{ version: string }];
    expect(version).toContain(`PostgreSQL ${build.serverVersion}`);
  });

  it('has as many applied migrations as its pin has', async () => {
    const [{ applied }] = (await database.query<{ applied: number }>(
      'select count(*)::int as applied from drizzle.__drizzle_migrations',
    )) as [{ applied: number }];
    expect(applied).toBe(fixture.migrations);
  });

  it('lists in the README the row count of every table', async () => {
    const readme = readmeCounts(readReadme());
    for (const table of COUNTED_TABLES) {
      const listed = readme.get(table)?.get(fixture.name);
      expect(listed, `${table} is listed for ${fixture.name}`).not.toBeUndefined();
      const [{ present }] = (await database.query<{ present: boolean }>(
        `select to_regclass('public.${table}') is not null as present`,
      )) as [{ present: boolean }];
      if (listed === null) {
        expect(present, `${table} is absent at this pin`).toBe(false);
        continue;
      }
      const [{ total }] = (await database.query<{ total: number }>(
        `select count(*)::int as total from public.${table}`,
      )) as [{ total: number }];
      expect(total, `${table} rows`).toBe(listed);
    }
  });

  it('opens again from its data folder with the same build', async () => {
    await database.close();
    const reopened = await openPglite(dataDirectory, fixture.pglite);
    const [{ total }] = (await reopened.query<{ total: number }>(
      'select count(*)::int as total from public.task',
    )) as [{ total: number }];
    expect(total).toBe(12);
    database = reopened;
  });

  it('holds tasks in every status, one of them closed, with legacy directories', async () => {
    const statuses = await database.query<{ status: string }>(
      'select distinct status::text as status from public.task order by 1',
    );
    expect(statuses.map((row) => row.status)).toEqual([
      'backlog',
      'done',
      'needs-me',
      'running',
      'todo',
      'waiting',
    ]);
    const [{ closed }] = (await database.query<{ closed: number }>(
      'select count(*)::int as closed from public.task where closed',
    )) as [{ closed: number }];
    expect(closed).toBe(1);
    const [{ legacy }] = (await database.query<{ legacy: number }>(
      'select count(*)::int as legacy from public.task where workdir is not null and home_workdir is not null',
    )) as [{ legacy: number }];
    expect(legacy).toBeGreaterThanOrEqual(8);
  });

  it('holds notes of every kind and author, with the server event as plain text', async () => {
    const kinds = await database.query<{ kind: string }>(
      'select distinct kind::text as kind from public.note order by 1',
    );
    expect(kinds.map((row) => row.kind)).toEqual([
      'answer',
      'comment',
      'event',
      'polish',
      'question',
    ]);
    const authors = await database.query<{ author: string }>(
      'select distinct author::text as author from public.note order by 1',
    );
    expect(authors.map((row) => row.author)).toEqual(['agent', 'server', 'system', 'user']);
    const plain = await database.query<{ body: string }>(
      `select body from public.note where body not like 'abe1.%'`,
    );
    expect(plain).toEqual([{ body: 'Moved from Todo to Running.' }]);
  });

  it('holds an interval, a cron and an after schedule', async () => {
    const [shape] = await database.query<{ every: number; cron: number; after: number }>(
      `select count(every_ms)::int as every, count(cron)::int as cron, count(after_schedule_id)::int as after from public.schedule`,
    );
    expect(shape).toEqual({ every: 1, cron: 1, after: 1 });
  });

  it('stores a token hash for every machine, matching the made-up token', async () => {
    const credentials = readCredentials(fixture.name);
    const stored = await database.query<{ name: string; token_hash: string }>(
      'select name, token_hash from public.machine order by name',
    );
    expect(stored.map((machine) => machine.name)).toEqual(Object.keys(credentials.machines).sort());
    for (const machine of stored) {
      expect(machine.token_hash).toBe(await tokenHash(credentials.machines[machine.name] ?? ''));
    }
  });

  it('holds only sealed envelopes and blind indexes in the sealed columns', async () => {
    let checked = 0;
    for (const { table, column, kind } of SEALED_COLUMNS) {
      const [{ present }] = (await database.query<{ present: boolean }>(
        `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${column}') as present`,
      )) as [{ present: boolean }];
      if (!present) continue;
      const filter = table === 'note' && column === 'body' ? `where author <> 'server'` : '';
      const values = await database.query<{ value: string | null }>(
        `select ${column} as value from public.${table} ${filter}`,
      );
      for (const { value } of values) {
        if (value === null) continue;
        checked++;
        expect(
          kind === 'envelope' ? isEnvelope(value) : isBlindIndex(value),
          `${table}.${column}`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('[migrate-012] names only the made-up owner and machines in its clear identity columns', async () => {
    const identities = await database.query<{ identity: string }>(`
      select distinct identity from (
        select username as identity from public.app_user
        union all select owner from public.machine
        union all select name from public.machine
        union all select owner from public.task
        union all select machine from public.task
        union all select owner from public.schedule
        union all select machine from public.schedule
        union all select owner from public.note
        union all select by from public.note
        union all select owner from public.task_pr
        union all select owner from public.transcript_run
        union all select machine from public.transcript_run
        union all select owner from public.transcript_event
      ) names where identity is not null order by identity`);
    expect(identities.map((row) => row.identity)).toEqual([
      'fixture-laptop',
      'fixture-owner',
      'fixture-server',
    ]);
  });

  it('unlocks with the passphrase and opens sealed values under the owner name', async () => {
    const credentials = readCredentials(fixture.name);
    const [user] = await database.query<{ key_id: string; key_slots: KeySlot[] }>(
      'select key_id, key_slots from public.app_user',
    );
    const keys = await unlockKeys(
      credentials.owner,
      { keyId: user?.key_id ?? '', slots: user?.key_slots ?? [] },
      { kind: 'passphrase', passphrase: credentials.passphrase },
    );
    expect(keys.keyId).toBe(credentials.keyId);
    expect((await deriveKeys(decodeDataKey(credentials.dataKey), credentials.owner)).keyId).toBe(
      keys.keyId,
    );

    const tasks = await database.query<{ id: string; schedule_id: string | null; title: string }>(
      'select id, schedule_id, title from public.task',
    );
    for (const task of tasks) {
      const binding = bindings.title(
        task.schedule_id === null ? { task: task.id } : { schedule: task.schedule_id },
      );
      expect((await open(keys, binding, task.title)).length).toBeGreaterThan(0);
    }
    const machines = await database.query<{ name: string; dirs: string }>(
      'select name, dirs from public.machine',
    );
    for (const machine of machines) {
      const dirs = JSON.parse(
        await open(keys, bindings.machineDocument('machine.dirs', machine.name), machine.dirs),
      ) as { dirs: unknown[] };
      expect(dirs.dirs.length).toBeGreaterThan(0);
    }
  });
});

const POSTGRES_URL = process.env['API_TEST_POSTGRES_URL'] ?? process.env['E2E_POSTGRES_URL'];

describe.skipIf(POSTGRES_URL === undefined)('fixture hosted-main on a Postgres server', () => {
  it('loads and reads like the PGlite stand-in', async () => {
    const loaded = await materializePostgres(POSTGRES_URL ?? '', 'hosted-main');
    const client = new pg.Client({ connectionString: loaded.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ version: string; tasks: number }>(
        "select current_setting('server_version') as version, (select count(*)::int from public.task) as tasks",
      );
      expect(rows[0]?.tasks).toBe(12);
      const readme = readmeCounts(readReadme());
      for (const table of COUNTED_TABLES) {
        const listed = readme.get(table)?.get('hosted-main');
        const { rows: counted } = await client.query<{ total: number }>(
          `select count(*)::int as total from public.${table}`,
        );
        expect(counted[0]?.total, table).toBe(listed);
      }
    } finally {
      await client.end();
      await loaded.drop();
    }
  });
});
