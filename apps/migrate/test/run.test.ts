import { mkdtemp, readdir, rm, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../fixtures/fixtures.js';
import { openPglite } from '../fixtures/materialize.js';
import {
  checkOwners,
  compareCounts,
  CountCheckFailure,
  formatDifferences,
  ImportFailure,
  importEnv,
  parseImportReport,
  parseTarget,
  run,
  RunRefusal,
  signInRuleOf,
  UsageError,
} from '../src/index.js';
import { writeFakeApi } from './support/fake-api.js';
import { materializeFolder, type MaterializedFolder } from './support/folders.js';
import { readCredentials } from './support/fixture-files.js';

describe('target database', () => {
  it('parses a PGlite folder and a Postgres URL and refuses anything else', () => {
    expect(parseTarget('pglite:///data/board')).toEqual({
      kind: 'pglite',
      directory: '/data/board',
    });
    expect(parseTarget('postgres://user:secret@host/db')).toEqual({ kind: 'postgres' });
    expect(() => parseTarget('pglite://')).toThrow(RunRefusal);
    expect(() => parseTarget('mysql://host/db')).toThrow('postgres:// or pglite://');
  });

  it('reads the no-login user the way the API does', () => {
    expect(signInRuleOf({ NO_LOGIN_USER: ' alice ' })).toEqual({ mode: 'no-login', user: 'alice' });
    expect(signInRuleOf({ AUTH_MODE: 'no-login', NO_LOGIN_USER: 'alice' })).toEqual({
      mode: 'no-login',
      user: 'alice',
    });
    expect(signInRuleOf({ PUBLIC_URL: 'https://board.example.test' })).toEqual({ mode: 'login' });
    expect(() => signInRuleOf({ AUTH_MODE: 'no-login' })).toThrow('NO_LOGIN_USER is required');
    expect(() => signInRuleOf({})).toThrow('neither NO_LOGIN_USER');
    expect(() => signInRuleOf({ AUTH_MODE: 'nologin', NO_LOGIN_USER: 'alice' })).toThrow(
      'AUTH_MODE must be "login" or "no-login"',
    );
  });

  it('gives the API the URLs it reads for each kind of target', () => {
    const env = {
      DATABASE_URL: 'postgres://board_app@host/db',
      DATABASE_ADMIN_URL: 'postgres://old@host/db',
      KEEP: '1',
    };
    expect(importEnv(env, { kind: 'pglite', directory: '/d' }, 'pglite:///d')).toEqual({
      ...env,
      DATABASE_URL: 'pglite:///d',
      DATABASE_ADMIN_URL: undefined,
    });
    expect(importEnv(env, { kind: 'postgres' }, 'postgres://admin@host/db')).toEqual({
      ...env,
      DATABASE_ADMIN_URL: 'postgres://admin@host/db',
    });
    expect(() => importEnv({}, { kind: 'postgres' }, 'postgres://admin@host/db')).toThrow(
      'needs DATABASE_URL',
    );
  });

  it('names both owners when a no-login target differs, also with several owners', () => {
    const rule = { mode: 'no-login', user: 'alice' } as const;
    expect(checkOwners(['alice'], rule)).toContain('ok');
    expect(() => checkOwners(['bob'], rule)).toThrow(/"bob".*"alice"/);
    expect(() => checkOwners(['alice', 'bob'], rule)).toThrow(/"bob".*"alice"/);
    expect(() => checkOwners([], rule)).toThrow('no owner');
    expect(checkOwners(['alice', 'bob'], { mode: 'login' })).toContain('alice, bob');
  });
});

describe('count check', () => {
  it('[migrate-007] lists every difference by owner and table and treats a missing table as zero', () => {
    const differences = compareCounts(
      { alice: { task: 3, note: 1 } },
      { alice: { task: 2 }, bob: { task: 1 } },
    );
    expect(differences).toEqual([
      { owner: 'alice', table: 'task', expected: 3, actual: 2 },
      { owner: 'alice', table: 'note', expected: 1, actual: 0 },
      { owner: 'bob', table: 'task', expected: 0, actual: 1 },
    ]);
    expect(formatDifferences(differences)).toMatch(/alice\s+task\s+3\s+2/);
    expect(compareCounts({ alice: { task: 1 } }, { alice: { task: 1 } })).toEqual([]);
  });

  it('parses the import report of the API', () => {
    const report = parseImportReport(
      'import finished for 1 owner(s)\nowner alice\n  user: 1\n  task: 12\ncount check passed\n',
    );
    expect(report).toEqual({ passed: true, owners: { alice: { user: 1, task: 12 } } });
    expect(parseImportReport('owner alice\n  task: 1\n').passed).toBe(false);
  });
});

describe('run with a stand-in API executable', () => {
  let scratch: string;
  let fakeApi: string;
  let previousTmp: string | undefined;
  const folders = new Map<string, MaterializedFolder>();

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'migrate-run-'));
    fakeApi = await writeFakeApi(scratch);
    for (const fixture of FIXTURES)
      folders.set(fixture.name, await materializeFolder(fixture.name));
    previousTmp = process.env.TMPDIR;
  });

  afterAll(async () => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    for (const folder of folders.values()) await folder.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  const source = (name: string): string => (folders.get(name) as MaterializedFolder).folder;
  const base = (name: string, target: string): string[] => [
    'run',
    '--source',
    source(name),
    '--api',
    fakeApi,
    '--target-db',
    `pglite://${target}`,
  ];
  const envFor = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH,
    NO_LOGIN_USER: 'fixture-owner',
    ...extra,
  });

  it.each(FIXTURES)('[migrate-011] passes the count check on $name', async (fixture) => {
    const target = join(scratch, `ok-${fixture.name}`);
    const output = await run(base(fixture.name, target), envFor());
    expect(output).toContain('owner check: ok, "fixture-owner" is the NO_LOGIN_USER');
    expect(output).toContain('count check passed');
  });

  it('prints counts and names only, never a token, key or passphrase', async () => {
    const credentials = readCredentials('local-v2');
    const output = await run(base('local-v2', join(scratch, 'quiet')), envFor());
    for (const secret of [
      credentials.dataKey,
      credentials.passphrase,
      credentials.recoveryKey,
      ...Object.values(credentials.machines),
    ])
      expect(output).not.toContain(secret);
  });

  it('warns about tasks that were running in the source', async () => {
    const output = await run(base('local-v2', join(scratch, 'warn')), envFor());
    expect(output).toMatch(/warning: 1 task\(s\) were running in the source/);
  });

  it('[migrate-007] fails the run with a difference table when one count is tampered', async () => {
    const target = join(scratch, 'tampered');
    const failure = await run(base('local-v2', target), envFor({ FAKE_TAMPER: 'task:-1' })).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CountCheckFailure);
    expect((failure as Error).message).toMatch(/fixture-owner\s+task\s+12\s+11/);
    expect((failure as Error).message).toContain('restore the scratch copy');
  });

  it('[migrate-006] dry run writes the export and the plan, imports nothing and touches no target', async () => {
    const marker = join(scratch, 'dry-marker');
    const target = join(scratch, 'dry-target');
    const out = join(scratch, 'dry.jsonl');
    const output = await run(
      [...base('local-v2', target), '--dry-run', '--out', out],
      envFor({ FAKE_MARKER: marker }),
    );
    expect(output).toContain('owner check: ok');
    expect(output).toContain('dry run: nothing imported');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const plan = JSON.parse(await readFile(`${out}.plan.json`, 'utf8')) as {
      owners: Record<string, Record<string, number>>;
      runningTasks: number;
    };
    expect(plan.owners['fixture-owner']?.task).toBe(12);
    expect(plan.runningTasks).toBe(1);
  });

  it('dry run still refuses an owner that differs and needs --out', async () => {
    const out = join(scratch, 'dry-refused.jsonl');
    await expect(
      run(
        [...base('local-v2', join(scratch, 'x')), '--dry-run', '--out', out],
        envFor({ NO_LOGIN_USER: 'someone' }),
      ),
    ).rejects.toThrow(RunRefusal);
    await expect(
      run([...base('local-v2', join(scratch, 'x')), '--dry-run'], envFor()),
    ).rejects.toThrow(UsageError);
  });

  it('refuses a different no-login owner before anything is written to the target', async () => {
    const marker = join(scratch, 'owner-marker');
    const target = join(scratch, 'owner-target');
    const failure = await run(
      base('local-v2', target),
      envFor({ NO_LOGIN_USER: 'someone', FAKE_MARKER: marker }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunRefusal);
    expect((failure as Error).message).toContain('"fixture-owner"');
    expect((failure as Error).message).toContain('"someone"');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a PGlite folder that holds the lock file before exporting', async () => {
    const marker = join(scratch, 'held-marker');
    const target = join(scratch, 'held-target');
    await mkdir(target);
    await writeFile(join(target, 'postmaster.pid'), '-42\n');
    await expect(run(base('local-v2', target), envFor({ FAKE_MARKER: marker }))).rejects.toThrow(
      /another process has it open/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a PGlite folder another process holds open', async () => {
    const target = join(scratch, 'open-target');
    const held = await openPglite(target, 'pglite-0-5-17');
    try {
      await expect(run(base('local-v2', target), envFor())).rejects.toThrow(RunRefusal);
    } finally {
      await held.close();
    }
  });

  it('[migrate-011] reports an import failure with the API message and removes the temporary export', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'migrate-tmpdir-'));
    process.env.TMPDIR = temporary;
    try {
      const failure = await run(
        base('local-v2', join(scratch, 'fail')),
        envFor({
          FAKE_FAIL: 'the target already holds the owner "fixture-owner"',
          TMPDIR: temporary,
        }),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ImportFailure);
      expect((failure as Error).message).toContain('the target already holds the owner');
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      process.env.TMPDIR = previousTmp ?? '';
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('keeps the export only when asked and writes it owner-only', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'migrate-keep-'));
    process.env.TMPDIR = temporary;
    try {
      const output = await run(
        [...base('local-v2', join(scratch, 'keep')), '--keep-export'],
        envFor(),
      );
      const kept = /export kept at (.+)$/m.exec(output)?.[1] as string;
      expect(kept.startsWith(temporary)).toBe(true);
      expect((await stat(kept)).mode & 0o777).toBe(0o600);
    } finally {
      process.env.TMPDIR = previousTmp ?? '';
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

const apiExecutable = process.env.MIGRATE_API_BIN;

describe.skipIf(apiExecutable === undefined)('run through the API executable', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'migrate-run-real-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const envFor = (user: string) => ({
    PATH: process.env.PATH,
    HOME: scratch,
    NO_LOGIN_USER: user,
  });

  async function rowCounts(directory: string): Promise<{ users: number; tasks: number }> {
    const { PGlite } = await import('pglite-target');
    const copy = join(scratch, `copy-${Math.random().toString(16).slice(2)}`);
    const { cp } = await import('node:fs/promises');
    await cp(directory, copy, { recursive: true });
    const database = new PGlite(copy);
    try {
      await database.waitReady;
      const count = async (table: string): Promise<number> =>
        Number(
          (await database.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]
            ?.n,
        );
      return { users: await count('app_user'), tasks: await count('task') };
    } finally {
      await database.close();
    }
  }

  it.each(FIXTURES)('imports $name and passes the count check', async (fixture) => {
    const source = await materializeFolder(fixture.name);
    const target = join(scratch, `real-${fixture.name}`);
    try {
      const output = await run(
        [
          'run',
          '--source',
          source.folder,
          '--api',
          apiExecutable as string,
          '--target-db',
          `pglite://${target}`,
        ],
        envFor('fixture-owner'),
      );
      expect(output).toContain('count check passed');
      expect(await rowCounts(target)).toEqual({ users: 1, tasks: 12 });
    } finally {
      await source.dispose();
    }
  });

  it('[migrate-008] leaves the target unchanged when the import is refused', async () => {
    const source = await materializeFolder('local-v2');
    const target = join(scratch, 'real-twice');
    const args = [
      'run',
      '--source',
      source.folder,
      '--api',
      apiExecutable as string,
      '--target-db',
      `pglite://${target}`,
    ];
    try {
      await run(args, envFor('fixture-owner'));
      const before = await rowCounts(target);
      const failure = await run(args, envFor('fixture-owner')).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ImportFailure);
      expect((failure as Error).message).toContain('already holds the owner');
      expect(await rowCounts(target)).toEqual(before);
    } finally {
      await source.dispose();
    }
  });

  it('refuses a different no-login owner without creating the target', async () => {
    const source = await materializeFolder('local-v2');
    const target = join(scratch, 'real-other');
    try {
      await expect(
        run(
          [
            'run',
            '--source',
            source.folder,
            '--api',
            apiExecutable as string,
            '--target-db',
            `pglite://${target}`,
          ],
          envFor('someone-else'),
        ),
      ).rejects.toThrow(RunRefusal);
      expect(existsSync(target)).toBe(false);
    } finally {
      await source.dispose();
    }
  });
});

const postgresBase = process.env.MIGRATE_TEST_POSTGRES_URL;

describe.skipIf(apiExecutable === undefined || postgresBase === undefined)(
  'run into a Postgres target',
  () => {
    const database = `migrate_${randomBytes(6).toString('hex')}`;
    const adminUrl = (): string => {
      const url = new URL(postgresBase as string);
      url.pathname = `/${database}`;
      return url.toString();
    };
    const appUrl = (): string => {
      const url = new URL(adminUrl());
      url.username = 'board_app';
      url.password = 'migrate-test-password';
      return url.toString();
    };

    beforeAll(async () => {
      const client = new pg.Client({ connectionString: postgresBase });
      await client.connect();
      await client.query(`create database "${database}"`);
      await client.end();
    });

    afterAll(async () => {
      const client = new pg.Client({ connectionString: postgresBase });
      await client.connect();
      await client.query(`drop database if exists "${database}" with (force)`);
      await client.end();
    });

    it('[migrate-008] imports once and leaves the rows unchanged when a second run is refused', async () => {
      const source = await materializeFolder('local-v2');
      const args = [
        'run',
        '--source',
        source.folder,
        '--api',
        apiExecutable as string,
        '--target-db',
        adminUrl(),
      ];
      const env = {
        PATH: process.env.PATH,
        NO_LOGIN_USER: 'fixture-owner',
        DATABASE_URL: appUrl(),
      };
      const count = async (): Promise<number[]> => {
        const client = new pg.Client({ connectionString: adminUrl() });
        await client.connect();
        try {
          const tables = ['app_user', 'task', 'note', 'machine'];
          const counts: number[] = [];
          for (const table of tables)
            counts.push(
              Number((await client.query(`select count(*)::int as n from ${table}`)).rows[0].n),
            );
          return counts;
        } finally {
          await client.end();
        }
      };
      try {
        expect(await run(args, env)).toContain('count check passed');
        const before = await count();
        expect(before[0]).toBe(1);
        const failure = await run(args, env).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ImportFailure);
        expect(await count()).toEqual(before);
      } finally {
        await source.dispose();
      }
    });
  },
);
