import { bindings } from '@rumo/sealing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { call, machineToken } from '../src/client/contract-client.js';
import { unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { startLoginBoard, type LoginBoard } from '../src/fixtures/login-board.js';
import { enrolledMachine, type EnrolledMachine } from '../src/fixtures/machines.js';
import { createTask, type CreatedTask } from '../src/fixtures/tasks.js';
import { signedInUser, type BoardUser } from '../src/fixtures/users.js';
import { missingParts } from '../src/harness/paths.js';
import { featureSkipReason, partSkipReason, unservedSkipReason } from '../src/harness/skip.js';
import {
  accountRows,
  IMPORT_ORDER,
  importAccountTable,
  skipVitest,
} from '../src/steps/migration.js';

interface Moved {
  readonly a: LoginBoard;
  readonly b: LoginBoard;
  readonly userA: BoardUser;
  readonly userB: BoardUser;
  readonly key: UnlockedKey;
  readonly tasks: readonly CreatedTask[];
  readonly machine: EnrolledMachine;
}

const SETUP_TIMEOUT_MS = 180_000;

describe('moving an account between two servers', () => {
  const boards: LoginBoard[] = [];
  let moved: Moved | null = null;
  let reason: string | null = null;

  beforeAll(async () => {
    const missing = missingParts(['api', 'cli']);
    if (missing.length > 0) {
      reason = partSkipReason(missing);
      return;
    }
    const a = await startLoginBoard({ label: 'move-a', features: ['board-export'] });
    boards.push(a);
    const b = await startLoginBoard({ label: 'move-b', features: ['board-export'] });
    boards.push(b);
    const absent = [...a.missingFeatures, ...b.missingFeatures];
    if (absent.length > 0) {
      reason = featureSkipReason(absent);
      return;
    }

    try {
      const userA = await signedInUser(a);
      const key = await unlockedKey(a, userA);
      const tasks = [
        await createTask(a, userA, key, { prompt: 'first card to move', status: 'todo' }),
        await createTask(a, userA, key, { prompt: 'second card to move', status: 'backlog' }),
      ];
      const machine = await enrolledMachine(a, userA, { key, name: 'mover' });

      const userB = await signedInUser(b);
      const keys = await userA.ok('client.keys.get', {});
      if (keys.setup === null) throw new Error('the source account holds no key setup');
      await userB.ok('client.keys.setup', keys.setup);
      for (const table of IMPORT_ORDER) {
        const rows = await accountRows(userA, table);
        if (rows.length === 0) continue;
        const result = await importAccountTable(userB, key.keyId, table, rows);
        expect(result.invalid, table).toBe(0);
        expect(result.orphaned, table).toBe(0);
        expect(result.inserted + result.existing, table).toBe(rows.length);
      }
      moved = { a, b, userA, userB, key, tasks, machine };
    } catch (error) {
      reason = unservedSkipReason(error);
      if (reason === null) throw error;
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all(boards.map((board) => board.stop()));
  });

  beforeEach((context) => {
    if (reason !== null) skipVitest(context, reason);
  });

  it('[api-100] the owner, the key id and every id are the same on the second server', async () => {
    const { userA, userB, key, tasks } = moved as Moved;
    expect(userB.owner).toBe(userA.owner);
    expect((await userB.ok('client.keys.get', {})).setup?.keyId).toBe(key.keyId);

    const idsA = (await userA.ok('client.tasks.list', {})).tasks.map((task) => task.id).sort();
    const listedB = (await userB.ok('client.tasks.list', {})).tasks;
    expect(listedB.map((task) => task.id).sort()).toEqual(idsA);
    for (const task of tasks) {
      const imported = listedB.find((entry) => entry.id === task.id);
      expect(imported).toBeDefined();
      expect(await key.open(bindings.title({ task: task.id }), imported?.title ?? '')).toBe(
        task.title,
      );
    }

    const machinesA = (await userA.ok('client.machines.list', {})).machines.map(
      (machine) => machine.name,
    );
    const machinesB = (await userB.ok('client.machines.list', {})).machines.map(
      (machine) => machine.name,
    );
    expect(machinesB.sort()).toEqual(machinesA.sort());
  });

  it('[api-100] the machine token issued on the first server works on the second', async () => {
    const { b, key, machine } = moved as Moved;
    const answer = await call({ url: b.url }, 'machine.version', {}, machineToken(machine.token));
    expect(answer.ok).toBe(true);
    expect(answer.body?.keyId).toBe(key.keyId);
    expect(answer.body?.machine).toBe(machine.name);
  });

  it('[api-100] board tasks after changing the server URL lists the moved tasks', async () => {
    const { b, tasks, machine } = moved as Moved;
    const init = await machine.cli([
      'init',
      '--url',
      b.url,
      '--token-file',
      machine.tokenFile,
      '--data-key-file',
      machine.dataKeyFile,
      '--force',
    ]);
    expect(init.code, `${init.stdout}${init.stderr}`).toBe(0);
    const listed = await machine.cli(['tasks', '--all', '--json']);
    expect(listed.code, `${listed.stdout}${listed.stderr}`).toBe(0);
    for (const task of tasks) expect(listed.stdout).toContain(task.id);
  });
});
