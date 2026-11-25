import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { bindings } from '@agent-board/sealing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { unlockedKey } from '../src/fixtures/keys.js';
import { killStubTree } from '../src/harness/run.js';
import {
  accountCounts,
  exportCounts,
  existingMachine,
  openMigrated,
  outputOf,
  rowsOf,
  skipVitest,
  waitFor,
  type MigratedBoard,
  type MigratedOptions,
} from '../src/steps/migration.js';
import { directoryIdOf } from '../src/steps/worker.js';

const OPTIONS: MigratedOptions = {
  parts: ['api', 'cli', 'migrate'],
  features: ['board-export'],
  via: 'run',
  label: 'migrate',
};
const SETUP_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 300_000;

let board: MigratedBoard | null = null;
let unavailable: string | null = null;

beforeAll(async () => {
  const opened = await openMigrated(OPTIONS);
  if ('unavailable' in opened) {
    unavailable = opened.unavailable;
    return;
  }
  board = opened;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await board?.stop();
  board = null;
});

beforeEach((context) => {
  if (unavailable !== null) skipVitest(context, unavailable);
});

function reportHasCount(report: string, table: string, count: number): boolean {
  const named = new RegExp(`(^|[^a-z_])${table}([^a-z_]|$)`, 'i');
  const counted = new RegExp(`(^|\\D)${count}(\\D|$)`);
  return report.split('\n').some((line) => named.test(line) && counted.test(line));
}

describe('migrating the source fixture', () => {
  it('[migrate-002] the export holds every kind of row the migration moves', () => {
    const { source } = board as MigratedBoard;
    const tables = new Set(source.records.map((record) => record.table));
    for (const table of [
      'user',
      'passkey',
      'machine',
      'project',
      'task',
      'task_pr',
      'note',
      'schedule',
      'transcript_run',
      'transcript_event',
      'legacy_dirs',
      'document',
    ] as const) {
      expect(tables.has(table), table).toBe(true);
    }
    const kinds = new Set(rowsOf(source, 'document').map(({ row }) => row.kind));
    expect([...kinds].sort()).toEqual(['agents', 'links', 'settings', 'titles']);
    expect(rowsOf(source, 'task').some(({ row }) => row.watches !== null)).toBe(true);
    expect(rowsOf(source, 'note').some(({ row }) => row.questions !== null)).toBe(true);
    expect(rowsOf(source, 'machine').every(({ row }) => /^[0-9a-f]{64}$/.test(row.tokenHash))).toBe(
      true,
    );
  });

  it('[migrate-002] the import report states per-table, per-owner counts equal to the source and the count check passed', () => {
    const live = board as MigratedBoard;
    const counts = exportCounts(live.source, live.owner);
    expect(Object.keys(counts).length).toBeGreaterThan(0);
    expect(live.report).toContain(live.owner);
    for (const [table, count] of Object.entries(counts)) {
      expect(reportHasCount(live.report, table, count), `${table}: ${count}\n${live.report}`).toBe(
        true,
      );
    }
    expect(live.report).toMatch(/count check passed/i);
    expect(live.report).not.toMatch(/mismatch|differs|count check failed/i);
  });

  it('[migrate-002] the target holds the source counts per table for the owner and the same users, key slots and machines', async () => {
    const live = board as MigratedBoard;
    const user = await live.user();
    expect(user.owner).toBe(live.owner);

    const expected = exportCounts(live.source, live.owner);
    const actual = await accountCounts(user);
    for (const [table, count] of Object.entries(expected)) {
      if (table === 'user' || table === 'passkey') continue;
      expect(actual[table], table).toBe(count);
    }
    for (const table of Object.keys(actual)) expect(expected[table], table).toBeDefined();

    const [owner] = rowsOf(live.source, 'user').filter((record) => record.owner === live.owner);
    expect(owner).toBeDefined();
    const keys = await user.ok('client.keys.get', {});
    expect(keys.setup?.keyId).toBe(owner?.row.keyId);
    expect(keys.setup?.slots).toEqual(owner?.row.keySlots);

    const listed = await user.ok('client.machines.list', {});
    const sourceMachines = rowsOf(live.source, 'machine').map(({ row }) => row.name);
    expect(listed.machines.map((machine) => machine.name).sort()).toEqual(sourceMachines.sort());
  });

  it('[migrate-002] every machine token of the source authenticates on the target', async () => {
    const live = board as MigratedBoard;
    const user = await live.user();
    const key = await unlockedKey(live, user, live.fixture.passphrase);
    expect(live.fixture.machines.length).toBeGreaterThan(0);
    for (const entry of live.fixture.machines) {
      const machine = existingMachine(live, entry, key);
      const version = await machine.ok('machine.version', {});
      expect(version.owner).toBe(live.owner);
      expect(version.keyId).toBe(key.keyId);
    }
  });
});

describe('a worker after the migration', () => {
  it(
    '[migrate-004] a CLI set up with board init from the existing token and data key claims and runs a task to Done with the stub',
    async (context) => {
      const opened = await openMigrated({ ...OPTIONS, label: 'migrate-worker' });
      if ('unavailable' in opened) return skipVitest(context, opened.unavailable);
      const live = opened;
      const user = await live.user();
      const key = await unlockedKey(live, user, live.fixture.passphrase);
      const [entry] = live.fixture.machines;
      if (entry === undefined) throw new Error('the fixture holds no machine');

      const machine = existingMachine(live, entry, key);
      try {
        const init = await machine.init();
        expect(init.code, outputOf(init)).toBe(0);

        const workdir = machine.tmp.path('work', 'main');
        mkdirSync(workdir, { recursive: true });
        const added = await machine.cli(['dirs', 'add', workdir]);
        expect(added.code, outputOf(added)).toBe(0);
        const directoryId = await directoryIdOf(user, key, machine.name, workdir);

        const id = `t-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        await user.ok('client.tasks.create', {
          id,
          title: await key.seal(bindings.title({ task: id }), 'worker after migration'),
          input: await key.seal(
            bindings.input({ origin: { task: id }, creator: 'user', directoryId }),
            '#stub: done',
          ),
          when: 'now',
          priority: 'urgent',
          place: { machine: machine.name, directoryId },
        });

        const done = await waitFor(
          async () => {
            await machine.cli(['internal', 'dispatch'], { timeoutMs: 60_000 });
            const detail = await user.ok('client.tasks.get', { id });
            return detail.task.status === 'done' ? detail.task : null;
          },
          {
            label: 'the migrated worker to run the task to Done',
            timeoutMs: 90_000,
            intervalMs: 1_000,
          },
        );
        expect(done.id).toBe(id);
      } finally {
        killStubTree(machine.stubLog);
        await live.stop();
      }
    },
    RUN_TIMEOUT_MS,
  );
});
