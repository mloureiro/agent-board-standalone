import { mkdirSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { killStubTree } from '../src/harness/run.js';
import {
  conversionFor,
  existingMachine,
  openMigrated,
  outputOf,
  rowsOf,
  skipVitest,
  startLegacyDirsProxy,
  waitFor,
  type ExistingMachine,
  type MigratedBoard,
  type MigratedOptions,
} from '../src/steps/migration.js';

const OPTIONS: MigratedOptions = {
  parts: ['api', 'cli', 'migrate'],
  features: ['legacy-dirs', 'directories'],
  via: 'import',
  label: 'legacy-dirs',
};
const SETUP_TIMEOUT_MS = 180_000;

const READ_ONLY_TITLE =
  '[api-125] the import keeps each machine document and legacy directory as stored and the version answer reports legacyDirs';

let board: MigratedBoard | null = null;
let shared: MigratedBoard | null = null;
let own: MigratedBoard | null = null;
let unavailable: string | null = null;

beforeAll(async () => {
  const opened = await openMigrated(OPTIONS);
  if ('unavailable' in opened) {
    unavailable = opened.unavailable;
    return;
  }
  shared = opened;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await shared?.stop();
  shared = null;
});

beforeEach(async (context) => {
  if (unavailable !== null) skipVitest(context, unavailable);
  if (context.task.name === READ_ONLY_TITLE) {
    board = shared;
    return;
  }
  const opened = await openMigrated(OPTIONS);
  if ('unavailable' in opened) skipVitest(context, opened.unavailable);
  own = opened;
  board = opened;
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await own?.stop();
  own = null;
  board = null;
});

interface Setup {
  readonly live: MigratedBoard;
  readonly key: UnlockedKey;
  readonly machines: ExistingMachine[];
}

async function setup(): Promise<Setup> {
  const live = board as MigratedBoard;
  const user = await live.user();
  const key = await unlockedKey(live, user, live.fixture.passphrase);
  return {
    live,
    key,
    machines: live.fixture.machines.map((machine) => existingMachine(live, machine, key)),
  };
}

function legacyKey(use: { kind: string; id: string }): string {
  return `${use.kind}:${use.id}`;
}

function sourceLegacyValues(live: MigratedBoard): Map<string, string> {
  const values = new Map<string, string>();
  for (const { row } of rowsOf(live.source, 'task')) {
    if (row.legacyDirectory !== null) values.set(`task:${row.id}`, row.legacyDirectory);
  }
  for (const { row } of rowsOf(live.source, 'schedule')) {
    if (row.legacyDirectory !== null) values.set(`schedule:${row.id}`, row.legacyDirectory);
  }
  return values;
}

describe('legacy directories after a board import', () => {
  it('[api-125] the import keeps each machine document and legacy directory as stored and the version answer reports legacyDirs', async () => {
    const { live, machines } = await setup();
    const documents = new Map(
      rowsOf(live.source, 'legacy_dirs').map(({ row }) => [row.machineName, row.document]),
    );
    const seen = new Map<string, string>();
    for (const machine of machines) {
      expect(documents.has(machine.name)).toBe(true);
      const version = await machine.ok('machine.version', {});
      expect(version.legacyDirs).toBe(true);
      const legacy = await machine.ok('machine.get-legacy-dirs', {});
      expect(legacy.document).toBe(documents.get(machine.name));
      for (const use of legacy.tasks) seen.set(legacyKey(use), use.legacyDirectory);
    }
    const stored = sourceLegacyValues(live);
    expect(stored.size).toBeGreaterThan(0);
    for (const [id, value] of stored) expect(seen.get(id)).toBe(value);

    const user = await live.user();
    const listed = await user.ok('client.tasks.list', {});
    const sourceTasks = new Map(rowsOf(live.source, 'task').map(({ row }) => [row.id, row]));
    for (const task of listed.tasks) {
      expect(task.legacyDirectory).toBe(sourceTasks.get(task.id)?.legacyDirectory ?? null);
      if (task.legacyDirectory !== null) expect(task.directoryId).toBeNull();
    }
  });

  it('[api-125] convert-legacy-dirs inserts directory rows in the default project, sets directory_id, clears legacy values and deletes the document', async () => {
    const { live, key, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const legacy = await machine.ok('machine.get-legacy-dirs', {});
    const conversion = await conversionFor(key, legacy.tasks);
    expect(conversion.assign.length).toBeGreaterThan(0);

    const answer = await machine.ok('machine.convert-legacy-dirs', {
      directories: conversion.directories,
      assign: conversion.assign,
    });
    expect(answer).toMatchObject({
      inserted: conversion.directories.length,
      assigned: conversion.assign.length,
    });

    const user = await live.user();
    const projects = await user.ok('client.projects.list', {});
    const defaultProject = projects.projects.find((project) => project.isDefault);
    expect(defaultProject).toBeDefined();
    const directories = await user.ok('client.directories.list', { machine: machine.name });
    const ids = new Set(conversion.directories.map((directory) => directory.id));
    const created = directories.directories.filter((directory) => ids.has(directory.id));
    expect(created).toHaveLength(ids.size);
    for (const directory of created) expect(directory.projectId).toBe(defaultProject?.id);

    const tasks = (await user.ok('client.tasks.list', {})).tasks;
    const expected = new Map(
      conversion.assign.filter((pair) => pair.kind === 'task').map((pair) => [pair.id, pair]),
    );
    expect(expected.size).toBeGreaterThan(0);
    for (const task of tasks) {
      const pair = expected.get(task.id);
      if (pair === undefined) continue;
      expect(task.directoryId).toBe(pair.directoryId);
      expect(task.legacyDirectory).toBeNull();
    }

    expect((await machine.ok('machine.version', {})).legacyDirs).toBe(false);
    expect((await machine.ok('machine.get-legacy-dirs', {})).document).toBeNull();
  });

  it('[api-125] a repeated convert-legacy-dirs is a no-op', async () => {
    const { live, key, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const legacy = await machine.ok('machine.get-legacy-dirs', {});
    const conversion = await conversionFor(key, legacy.tasks);
    const request = { directories: conversion.directories, assign: conversion.assign };
    await machine.ok('machine.convert-legacy-dirs', request);

    const user = await live.user();
    const before = (await user.ok('client.directories.list', {})).directories;
    const repeated = await machine.ok('machine.convert-legacy-dirs', request);
    expect(repeated).toMatchObject({ inserted: 0, assigned: 0 });
    const after = (await user.ok('client.directories.list', {})).directories;
    expect(after).toEqual(before);
  });

  it('[api-125] pairs whose legacy directory another machine already cleared are skipped and reported', async () => {
    const { live, key, machines } = await setup();
    const [first, second] = machines;
    if (first === undefined || second === undefined) {
      throw new Error('the fixture needs two machines');
    }
    const firstUses = (await first.ok('machine.get-legacy-dirs', {})).tasks;
    const secondUses = (await second.ok('machine.get-legacy-dirs', {})).tasks;
    const firstKeys = new Set(firstUses.map(legacyKey));
    const shared = secondUses.filter((use) => firstKeys.has(legacyKey(use)));
    expect(shared.length).toBeGreaterThan(0);

    const firstConversion = await conversionFor(key, firstUses);
    await first.ok('machine.convert-legacy-dirs', {
      directories: firstConversion.directories,
      assign: firstConversion.assign,
    });
    const firstDirectories = new Map(
      firstConversion.assign.map((pair) => [legacyKey(pair), pair.directoryId]),
    );

    const secondConversion = await conversionFor(key, secondUses);
    const answer = await second.ok('machine.convert-legacy-dirs', {
      directories: secondConversion.directories,
      assign: secondConversion.assign,
    });
    const sharedKeys = new Set(shared.map(legacyKey));
    const skipped = secondConversion.assign.filter((pair) => sharedKeys.has(legacyKey(pair)));
    expect(skipped.length).toBeGreaterThan(0);
    expect(answer.assigned).toBe(secondConversion.assign.length - skipped.length);

    const user = await live.user();
    const tasks = (await user.ok('client.tasks.list', {})).tasks;
    for (const task of tasks) {
      const owned = firstDirectories.get(`task:${task.id}`);
      if (owned !== undefined && sharedKeys.has(`task:${task.id}`)) {
        expect(task.directoryId).toBe(owned);
      }
    }
  });
});

describe('the CLI converts legacy directories', () => {
  function reportedCounts(output: string): { matched: number; unmatched: number } {
    const matched = /(\d+)\s+matched/i.exec(output);
    const unmatched = /(\d+)\s+(?:unmatched|did not match|not matched)/i.exec(output);
    expect(matched, output).not.toBeNull();
    expect(unmatched, output).not.toBeNull();
    return { matched: Number(matched?.[1]), unmatched: Number(unmatched?.[1]) };
  }

  it('[cli-085] board init converts the machine legacy directories first and reports matched and unmatched counts', async () => {
    const { live, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const before = await machine.ok('machine.get-legacy-dirs', {});
    expect(before.document).not.toBeNull();
    const user = await live.user();
    const beforeTasks = (await user.ok('client.tasks.list', {})).tasks;
    expect(beforeTasks.every((task) => task.directoryId === null)).toBe(true);

    const result = await machine.init();
    expect(result.code, outputOf(result)).toBe(0);
    const counts = reportedCounts(outputOf(result));

    expect((await machine.ok('machine.version', {})).legacyDirs).toBe(false);
    expect(counts.matched + counts.unmatched).toBe(before.tasks.length);
    const afterTasks = [
      ...new Map(
        [
          ...(await user.ok('client.tasks.list', {})).tasks,
          ...(await user.ok('client.tasks.list', { closed: 'true' })).tasks,
        ].map((task) => [task.id, task]),
      ).values(),
    ];
    const taskUses = new Set(
      before.tasks.filter((use) => use.kind === 'task').map((use) => use.id),
    );
    const scheduleUses = before.tasks.length - taskUses.size;
    const converted = afterTasks.filter((task) => taskUses.has(task.id));
    const matchedTasks = converted.filter((task) => task.directoryId !== null).length;
    const unmatchedTasks = converted.filter((task) => task.directoryId === null).length;
    expect(matchedTasks).toBeLessThanOrEqual(counts.matched);
    expect(matchedTasks).toBeGreaterThanOrEqual(counts.matched - scheduleUses);
    expect(unmatchedTasks).toBeLessThanOrEqual(counts.unmatched);
    expect(unmatchedTasks).toBeGreaterThanOrEqual(counts.unmatched - scheduleUses);
    expect(counts.matched).toBeGreaterThan(0);
  });

  it('[cli-085] a task whose legacy path matched nothing keeps no directory', async () => {
    const { live, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const before = await machine.ok('machine.get-legacy-dirs', {});
    const result = await machine.init();
    expect(result.code, outputOf(result)).toBe(0);

    const user = await live.user();
    const mine = new Set(before.tasks.map((use) => use.id));
    const afterTasks = (await user.ok('client.tasks.list', {})).tasks.filter((task) =>
      mine.has(task.id),
    );
    const unmatched = afterTasks.filter((task) => task.directoryId === null);
    expect(unmatched.length).toBeGreaterThan(0);
    for (const task of unmatched) {
      expect(task.legacyDirectory).not.toBeNull();
    }
  });

  it('[cli-085] the listener start converts the legacy directories when the flag is set', async () => {
    const { live, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const proxy = await startLegacyDirsProxy(live.url);
    const listener = { current: null as ReturnType<ExistingMachine['start']> | null };
    try {
      const init = await machine.init(proxy.url);
      expect(init.code, outputOf(init)).toBe(0);
      expect((await machine.ok('machine.version', {})).legacyDirs).toBe(true);

      proxy.hide(false);
      listener.current = machine.start(['internal', 'listen']);
      await waitFor(async () => !(await machine.ok('machine.version', {})).legacyDirs, {
        label: 'the listener to convert the legacy directories',
        timeoutMs: 60_000,
      });
      const user = await live.user();
      const directories = await user.ok('client.directories.list', { machine: machine.name });
      expect(directories.directories.length).toBeGreaterThan(0);
    } finally {
      await listener.current?.stop();
      killStubTree(machine.stubLog);
      await proxy.stop();
    }
  });

  it('[cli-085] set-dirs converts the legacy directories first when the flag is set', async () => {
    const { live, machines } = await setup();
    const [machine] = machines;
    if (machine === undefined) throw new Error('the fixture holds no machine');
    const proxy = await startLegacyDirsProxy(live.url);
    try {
      const init = await machine.init(proxy.url);
      expect(init.code, outputOf(init)).toBe(0);
      expect((await machine.ok('machine.version', {})).legacyDirs).toBe(true);

      proxy.hide(false);
      const workdir = machine.tmp.path('work', 'new-dir');
      mkdirSync(workdir, { recursive: true });
      const added = await machine.cli(['dirs', 'add', workdir]);
      expect(added.code, outputOf(added)).toBe(0);
      expect(outputOf(added)).toMatch(/matched/i);
      expect((await machine.ok('machine.version', {})).legacyDirs).toBe(false);

      const user = await live.user();
      const tasks = (await user.ok('client.tasks.list', {})).tasks;
      expect(tasks.some((task) => task.directoryId !== null)).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
