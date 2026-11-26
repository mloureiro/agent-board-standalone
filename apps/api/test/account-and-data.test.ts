import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCOUNT_TABLES,
  boardExportRecord,
  type AccountTable,
  type BoardExportRecord,
} from '@agent-board/contract';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';
import { runImport } from '../src/import-command.js';
import {
  BoardImportRefusal,
  formatImportReport,
  importBoard,
  readBoardFile,
} from '../src/modules/board-export/index.js';
import type { Database } from '../src/modules/database/index.js';
import { createMemoryEvents } from '../src/modules/events/index.js';
import { bootOn, CLIENT_HEADERS } from './fixtures/board.js';
import {
  countsOf,
  envelope,
  exportFile,
  PROJECT_DEFAULT,
  syntheticRecords,
  WATCH_STOPS,
} from './fixtures/synthetic-board.js';
import { TARGETS, type OpenedTarget } from './integration/targets.js';
import { tokenHashOf } from './fixtures/tokens.js';

const IMPORT_ORDER: readonly AccountTable[] = [
  'project',
  'machine',
  'directory',
  'task',
  'schedule',
  'note',
  'task_pr',
  'transcript_run',
  'transcript_event',
  'shared_agents',
  'link_rules',
  'title_rules',
  'setting',
  'legacy_dirs',
  'device',
];

const scratch: string[] = [];
const writeExport = (records: readonly BoardExportRecord[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'board-api-export-'));
  scratch.push(dir);
  const file = join(dir, 'board.jsonl');
  writeFileSync(file, exportFile(records));
  return file;
};

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const importFrom = async (
  database: Database,
  records: readonly BoardExportRecord[],
  noLoginUser: string | null = null,
) => importBoard(database, await readBoardFile(writeExport(records)), { noLoginUser });

const holds = (database: Database, owner: string): Promise<boolean> =>
  database.withOwner(
    owner,
    async (tx) => (await tx.$count(schema.appUser, eq(schema.appUser.username, owner))) > 0,
  );

const taskIds = (database: Database, owner: string): Promise<string[]> =>
  database.withOwner(owner, async (tx) =>
    (await tx.select({ id: schema.task.id }).from(schema.task)).map((row) => row.id).sort(),
  );

describe.each(TARGETS)('board import on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let opened: OpenedTarget;
    let database: Database;

    beforeAll(async () => {
      opened = await target.open();
      database = opened.database;
    });

    afterAll(async () => {
      await opened.cleanup();
    });

    it('[api-123] imports every owner in one run and reports per-table, per-owner counts that match the file', async () => {
      const alice = syntheticRecords({ owner: 'alice-import' });
      const bob = syntheticRecords({ owner: 'bob-import', machines: ['solo'] });
      const reports = await importFrom(database, [...alice, ...bob]);

      expect(reports.map((report) => report.owner)).toEqual(['alice-import', 'bob-import']);
      for (const [owner, records] of [
        ['alice-import', alice],
        ['bob-import', bob],
      ] as const) {
        const expected = countsOf(records);
        const reported = Object.fromEntries(
          reports
            .find((report) => report.owner === owner)
            ?.counts.map((entry) => [entry.table, entry.count]) ?? [],
        );
        expect(reported).toEqual(expected);
      }
      const text = formatImportReport(reports);
      expect(text).toMatch(/^ {2}task: 4$/m);
      expect(text).toMatch(/^ {2}note: 3$/m);
      expect(text).toMatch(/count check passed/);
    });

    it('[api-123] keeps sealed values, ids, key slots and the limits the export schema allows', async () => {
      const owner = 'carol-import';
      await importFrom(database, syntheticRecords({ owner }));
      await database.withOwner(owner, async (tx) => {
        const [parent] = await tx.select().from(schema.task).where(eq(schema.task.id, 't-parent'));
        expect(parent?.watchStops).toEqual(WATCH_STOPS);
        expect(parent?.title).toBe(envelope('title-t-parent'));
        const [server] = await tx.select().from(schema.note).where(eq(schema.note.id, 'n-server'));
        expect(server?.body).toHaveLength(3000);
        const events = await tx.select().from(schema.transcriptEvent);
        expect(events.find((event) => event.seq === 0)).toMatchObject({
          output: null,
          outputSize: 12,
        });
        const [user] = await tx.select().from(schema.appUser);
        expect(user?.keyId).toBe('0123456789abcdef');
        const [child] = await tx.select().from(schema.task).where(eq(schema.task.id, 't-child'));
        expect(child).toMatchObject({
          parentId: 't-parent',
          openQuestionNoteId: 'n-question',
          directoryId: null,
          legacyDirectory: envelope('legacy-child'),
        });
        const schedules = await tx.select().from(schema.schedule);
        expect(schedules.find((row) => row.id === 's-after')?.afterScheduleId).toBe('s-base');
        const dirs = await tx.select().from(schema.legacyDirs);
        expect(dirs.map((row) => row.machineId).sort()).toEqual(['alpha', 'beta']);
      });
    });

    it('[api-123] refuses a target that already holds any of the owners and writes nothing', async () => {
      await importFrom(database, syntheticRecords({ owner: 'dave-import' }));
      const records = [
        ...syntheticRecords({ owner: 'erin-import' }),
        ...syntheticRecords({ owner: 'dave-import', tokenSeed: 'again' }),
      ];
      await expect(importFrom(database, records)).rejects.toThrow(
        /already holds the owner "dave-import"/,
      );
      expect(await holds(database, 'erin-import')).toBe(false);
    });

    it('[api-123] runs in one transaction: a refused row in a later owner rolls back the earlier one', async () => {
      const broken = syntheticRecords({ owner: 'gina-import' });
      const index = broken.findIndex((entry) => entry.table === 'task_pr');
      const original = broken[index] as Extract<BoardExportRecord, { table: 'task_pr' }>;
      broken[index] = { ...original, row: { ...original.row, taskId: 'missing-task' } };
      await expect(
        importFrom(database, [...syntheticRecords({ owner: 'frank-import' }), ...broken]),
      ).rejects.toThrow(BoardImportRefusal);
      expect(await holds(database, 'frank-import')).toBe(false);
      expect(await holds(database, 'gina-import')).toBe(false);
    });

    it('[api-123] in no-login mode refuses an export whose owner is not NO_LOGIN_USER', async () => {
      await expect(
        importFrom(database, syntheticRecords({ owner: 'harry-import' }), 'someone-else'),
      ).rejects.toThrow(/not the NO_LOGIN_USER "someone-else"/);
      expect(await holds(database, 'harry-import')).toBe(false);
      await importFrom(database, syntheticRecords({ owner: 'ines-import' }), 'ines-import');
      expect(await holds(database, 'ines-import')).toBe(true);
    });

    it('[api-123] refuses an owner without exactly one user row', async () => {
      const withoutUser = syntheticRecords({ owner: 'jack-import' }).filter(
        (entry) => entry.table !== 'user',
      );
      await expect(importFrom(database, withoutUser)).rejects.toThrow(/exactly one user row/);
    });
  });
});

describe('agent-board-api import', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const environment = (owner: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'board-api-import-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return { DATABASE_URL: `pglite://${dir}`, NO_LOGIN_USER: owner };
  };

  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      options: { out: (text: string) => out.push(text), err: (text: string) => err.push(text) },
    };
  };

  it('[api-123] prints one line per table with its count and the count check, then refuses a second run', async () => {
    const records = syntheticRecords({ owner: 'cli-owner' });
    const file = writeExport(records);
    const env = environment('cli-owner');
    const first = capture();
    expect(await runImport(['--file', file], env, first.options)).toBe(0);
    const report = first.out.join('');
    for (const [table, count] of Object.entries(countsOf(records))) {
      expect(report).toMatch(new RegExp(`^ {2}${table}: ${count}$`, 'm'));
    }
    expect(report).toContain('owner cli-owner');
    expect(report).toContain('count check passed');

    const second = capture();
    expect(await runImport([`--file=${file}`], env, second.options)).toBe(1);
    expect(second.err.join('')).toMatch(/already holds the owner "cli-owner"/);
  });

  it('[api-123] refuses an owner other than NO_LOGIN_USER and a missing or unreadable file', async () => {
    const file = writeExport(syntheticRecords({ owner: 'cli-other' }));
    const refused = capture();
    expect(await runImport(['--file', file], environment('cli-expected'), refused.options)).toBe(1);
    expect(refused.err.join('')).toMatch(/NO_LOGIN_USER "cli-expected"/);

    const missing = capture();
    expect(
      await runImport(
        ['--file', '/nonexistent/board.jsonl'],
        environment('cli-expected'),
        missing.options,
      ),
    ).toBe(1);
    const usage = capture();
    expect(await runImport([], environment('cli-expected'), usage.options)).toBe(2);
  });

  it('[api-123] names the line of an invalid export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-api-export-'));
    scratch.push(dir);
    const file = join(dir, 'bad.jsonl');
    const lines = exportFile(syntheticRecords({ owner: 'cli-bad' })).split('\n');
    lines[3] = '{"owner":"cli-bad","table":"nope","row":{}}';
    writeFileSync(file, lines.join('\n'));
    const result = capture();
    expect(await runImport(['--file', file], environment('cli-bad'), result.options)).toBe(1);
    expect(result.err.join('')).toMatch(/line 4/);
  });
});

describe.each(TARGETS)('account export and import on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    let source: OpenedTarget;
    let destination: OpenedTarget;
    let sourceApp: FastifyInstance;
    let destinationApp: FastifyInstance;
    const owner = 'mover';
    const records = syntheticRecords({ owner });

    const call = async (app: FastifyInstance, url: string, payload?: unknown) => {
      const answer = await app.inject({
        method: payload === undefined ? 'GET' : 'POST',
        url,
        headers: CLIENT_HEADERS,
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      return { status: answer.statusCode, body: answer.json() as Record<string, unknown> };
    };

    const exportAll = async (app: FastifyInstance, table: AccountTable): Promise<unknown[]> => {
      const rows: unknown[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ table, ...(cursor === undefined ? {} : { cursor }) });
        const page = await call(app, `/api/client/account/export?${query.toString()}`);
        expect(page.status).toBe(200);
        rows.push(...(page.body.rows as unknown[]));
        cursor = (page.body.next as string | null) ?? undefined;
      } while (cursor !== undefined);
      return rows;
    };

    beforeAll(async () => {
      source = await target.open();
      destination = await target.open();
      await importBoard(source.database, await readBoardFile(writeExport(records)), {
        noLoginUser: owner,
      });
      await destination.database.withOwner(owner, async (tx) => {
        await tx.insert(schema.appUser).values({
          username: owner,
          keyId: '0123456789abcdef',
          keySlots: [{ kind: 'recovery', wrapped: `abw1.${'W'.repeat(80)}` }] as never,
        });
        await tx
          .insert(schema.project)
          .values({ id: '11111111-1111-4111-8111-111111111111', isDefault: true, position: 0 });
      });
      sourceApp = await bootOn(source.database, owner);
      destinationApp = await bootOn(destination.database, owner);
    });

    afterAll(async () => {
      await sourceApp.close();
      await destinationApp.close();
      await source.cleanup();
      await destination.cleanup();
    });

    it('[api-099] export pages every table as stored and each page parses as a board export row', async () => {
      const expected = countsOf(records);
      for (const table of ACCOUNT_TABLES) {
        const rows = await exportAll(sourceApp, table);
        expect(rows.length, table).toBe(expected[table] ?? 0);
        for (const row of rows) {
          const exportTable =
            table === 'shared_agents' ||
            table === 'link_rules' ||
            table === 'title_rules' ||
            table === 'setting'
              ? 'document'
              : table;
          expect(
            boardExportRecord.safeParse({ owner, table: exportTable, row }).success,
            table,
          ).toBe(true);
        }
      }
      const tasks = (await exportAll(sourceApp, 'task')) as { id: string; title: string }[];
      expect(tasks.find((row) => row.id === 't-parent')?.title).toBe(envelope('title-t-parent'));
    });

    it('[api-099] export follows its cursor across pages and refuses a cursor from another table', async () => {
      await source.database.withOwner(owner, async (tx) => {
        await tx.insert(schema.task).values(
          Array.from({ length: 450 }, (_, index) => ({
            id: `bulk-${String(index).padStart(4, '0')}`,
            title: envelope('bulk'),
            input: envelope('bulk'),
            position: index,
            projectId: PROJECT_DEFAULT,
          })),
        );
      });
      const rows = (await exportAll(sourceApp, 'task')) as { id: string }[];
      const ids = rows.map((row) => row.id);
      expect(ids).toHaveLength(454);
      expect(new Set(ids).size).toBe(454);
      expect(ids).toEqual([...ids].sort());
      const first = await call(sourceApp, '/api/client/account/export?table=task');
      const cursor = first.body.next as string;
      const wrong = await call(
        sourceApp,
        `/api/client/account/export?${new URLSearchParams({ table: 'transcript_event', cursor }).toString()}`,
      );
      expect(wrong.status).toBe(400);
    });

    it('[api-099] import accepts rows only under the key id the account holds', async () => {
      const wrong = await call(destinationApp, '/api/client/account/import', {
        keyId: 'ffffffffffffffff',
        table: 'project',
        rows: [],
      });
      expect(wrong.status).toBe(403);
      const none = await call(sourceApp, '/api/client/account/import', {
        keyId: '0123456789abcdef',
        table: 'project',
        rows: [],
      });
      expect(none.status).toBe(200);
    });

    it('[api-100] moving every table keeps owner, key id, ids and a usable machine token on the other server', async () => {
      for (const table of IMPORT_ORDER) {
        const rows = await exportAll(sourceApp, table);
        if (rows.length === 0) continue;
        const result = await call(destinationApp, '/api/client/account/import', {
          keyId: '0123456789abcdef',
          table,
          rows,
        });
        expect(result.status, table).toBe(200);
        expect(result.body, table).toMatchObject({ invalid: 0, orphaned: 0 });
        expect(Number(result.body.inserted) + Number(result.body.existing), table).toBe(
          rows.length,
        );
      }
      expect(await taskIds(destination.database, owner)).toEqual(
        await taskIds(source.database, owner),
      );

      const moved = await destination.database.withSystem((system) =>
        system.lookupMachine(tokenHashOf('mover', 0)),
      );
      expect(moved).toMatchObject({ owner, machineId: 'alpha', actsAsOwner: true });
      const projects = await destination.database.withOwner(owner, (tx) =>
        tx.select().from(schema.project),
      );
      expect(projects.filter((row) => row.isDefault).map((row) => row.id)).toEqual([
        PROJECT_DEFAULT,
      ]);
      const [user] = await destination.database.withOwner(owner, (tx) =>
        tx.select().from(schema.appUser),
      );
      expect(user?.keyId).toBe('0123456789abcdef');
    });

    it('[api-099] a repeated import inserts nothing and counts every row as existing', async () => {
      const rows = await exportAll(sourceApp, 'task');
      const again = await call(destinationApp, '/api/client/account/import', {
        keyId: '0123456789abcdef',
        table: 'task',
        rows,
      });
      expect(again.body).toEqual({ inserted: 0, existing: rows.length, invalid: 0, orphaned: 0 });
    });

    it('[api-099] an import announces a task change to the owner', async () => {
      const events = createMemoryEvents();
      const app = await bootOn(destination.database, owner, undefined, events);
      const seen: string[] = [];
      await events.subscribe(owner, (message) => seen.push(message.kind));
      const answer = await call(app, '/api/client/account/import', {
        keyId: '0123456789abcdef',
        table: 'task',
        rows: await exportAll(sourceApp, 'task'),
      });
      await app.close();
      expect(answer.status).toBe(200);
      expect(seen).toContain('tasks');
    });

    it('[api-099] rows that break the format or point at a missing parent are counted, not inserted', async () => {
      const [good] = (await exportAll(sourceApp, 'task_pr')) as Record<string, unknown>[];
      const answer = await call(destinationApp, '/api/client/account/import', {
        keyId: '0123456789abcdef',
        table: 'task_pr',
        rows: [
          { ...good, id: 'pr-orphan', taskId: 'nowhere' },
          { ...good, id: 'pr-invalid', pr: 'not sealed' },
          { ...good, id: 'pr-fine' },
        ],
      });
      expect(answer.body).toEqual({ inserted: 1, existing: 0, invalid: 1, orphaned: 1 });
    });

    it('[api-099] a session device cannot be imported', async () => {
      const [device] = (await exportAll(sourceApp, 'device')) as Record<string, unknown>[];
      const answer = await call(destinationApp, '/api/client/account/import', {
        keyId: '0123456789abcdef',
        table: 'device',
        rows: [{ ...device, keyId: '1111111111111111', kind: 'session' }],
      });
      expect(answer.body).toMatchObject({ inserted: 0, invalid: 1 });
    });
  });
});

describe.each(TARGETS)('account summary and delete on $name', (target) => {
  describe.skipIf(!target.enabled)('', () => {
    const owner = 'leaver';
    let opened: OpenedTarget;
    let app: FastifyInstance;
    const events = createMemoryEvents();

    const post = async (url: string, payload: unknown) => {
      const answer = await app.inject({
        method: 'POST',
        url,
        headers: CLIENT_HEADERS,
        payload: JSON.stringify(payload),
      });
      return { status: answer.statusCode, body: answer.json() as Record<string, unknown> };
    };

    beforeAll(async () => {
      opened = await target.open();
      await importFrom(opened.database, [
        ...syntheticRecords({ owner }),
        ...syntheticRecords({ owner: 'bystander' }),
      ]);
      app = await bootOn(opened.database, owner, undefined, events);
    });

    afterAll(async () => {
      await app.close();
      await opened.cleanup();
    });

    it('[api-099] the summary counts what the account holds', async () => {
      const answer = await app.inject({
        method: 'GET',
        url: '/api/client/account/summary',
        headers: CLIENT_HEADERS,
      });
      const expected = countsOf(syntheticRecords({ owner }));
      expect(answer.statusCode).toBe(200);
      expect(answer.json()).toMatchObject({
        tasks: expected.task,
        schedules: expected.schedule,
        machines: expected.machine,
        notes: expected.note,
        taskPrs: expected.task_pr,
        projects: expected.project,
        directories: expected.directory,
        transcriptRuns: expected.transcript_run,
        transcriptEvents: expected.transcript_event,
      });
    });

    it('[api-099] delete refuses a username that is not the signed-in one', async () => {
      const answer = await post('/api/client/account/delete', { username: 'someone-else' });
      expect(answer.status).toBe(403);
      expect(await holds(opened.database, owner)).toBe(true);
    });

    it('[api-099] delete removes every row of the owner and none of another owner', async () => {
      const others = await taskIds(opened.database, 'bystander');
      expect(others.length).toBeGreaterThan(0);
      const seen: string[] = [];
      await events.subscribe(owner, (message) => seen.push(message.kind));
      const answer = await post('/api/client/account/delete', { username: owner });
      expect(answer.status).toBe(200);
      expect(seen).toContain('revoked');
      expect(await holds(opened.database, owner)).toBe(false);
      for (const table of [
        schema.task,
        schema.schedule,
        schema.note,
        schema.machine,
        schema.project,
        schema.directory,
        schema.document,
        schema.transcriptRun,
        schema.transcriptEvent,
        schema.clientKey,
        schema.session,
      ])
        expect(
          await opened.database.withOwner(owner, (tx) => tx.$count(table)),
          String(table),
        ).toBe(0);
      expect(await taskIds(opened.database, 'bystander')).toEqual(others);
    });
  });
});
