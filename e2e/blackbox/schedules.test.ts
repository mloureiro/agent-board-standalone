import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { bindings } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import type { RouteOutput } from '../src/client/contract-client.js';
import { unlockedKey, type UnlockedKey } from '../src/fixtures/keys.js';
import { enrolledMachine, type EnrolledMachine } from '../src/fixtures/machines.js';
import { noLoginUser, type BoardUser } from '../src/fixtures/users.js';
import { setClockOffset } from '../src/harness/clock.js';
import { useBoard } from '../src/harness/vitest.js';
import { eventually, runIn } from '../src/steps/polling.js';

type WireTask = RouteOutput<'machine.list-tasks'>['tasks'][number];
type WireSchedule = RouteOutput<'machine.list-schedules'>['schedules'][number];

const HOUR_MS = 3_600_000;
const SLACK_MS = 5 * 60_000;

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

async function openTitle(key: UnlockedKey, task: WireTask): Promise<string> {
  return key.open(bindings.title({ task: task.id }), task.title);
}

describe('[cli-036] rumo schedule', () => {
  const harness = useBoard({
    parts: ['api', 'cli'],
    features: ['schedules', 'projects', 'directories'],
    auth: 'no-login',
  });

  let user: BoardUser;
  let key: UnlockedKey;
  let machine: EnrolledMachine;
  let directory: string;
  let defaultProject: string;
  let directoryId: string;

  const board = (args: readonly string[]) => runIn(machine, directory, args);
  const tasks = async (): Promise<WireTask[]> =>
    (await machine.ok('machine.list-tasks', { all: true })).tasks;
  const schedules = async (): Promise<WireSchedule[]> =>
    (await machine.ok('machine.list-schedules', {})).schedules;
  const tasksTitled = async (title: string): Promise<WireTask[]> => {
    const found: WireTask[] = [];
    for (const task of await tasks()) {
      if ((await openTitle(key, task).catch(() => null)) === title) found.push(task);
    }
    return found;
  };
  const scheduleTitled = async (title: string): Promise<WireSchedule[]> => {
    const found: WireSchedule[] = [];
    for (const schedule of await schedules()) {
      const opened = await key
        .open(bindings.title({ schedule: schedule.id }), schedule.title)
        .catch(() => null);
      if (opened === title) found.push(schedule);
    }
    return found;
  };

  const prepare = async (): Promise<void> => {
    if (machine !== undefined) return;
    const { board: running } = harness;
    user = await noLoginUser(running);
    key = await unlockedKey(running, user);
    machine = await enrolledMachine(running, user, { key, name: 'scheduler', actsAsOwner: true });
    directory = running.tmp.path('work', 'allowed');
    mkdirSync(directory, { recursive: true });
    const added = await runIn(machine, directory, ['dirs', 'add', '--no-repo']);
    expect(added.code, added.stderr).toBe(0);
    const projects = await user.ok('client.projects.list', {});
    defaultProject = (projects.projects.find((project) => project.isDefault) ?? { id: '' }).id;
    expect(defaultProject).not.toBe('');
    const listed = await user.ok('client.directories.list', {});
    const own = listed.directories.at(0);
    expect(listed.directories).toHaveLength(1);
    directoryId = own?.id ?? '';
  };

  it('[cli-036] creates a one-off task bound to this machine, an allowed directory and the project', async () => {
    await prepare();
    const result = await board([
      'schedule',
      '--in',
      '1h',
      '--title',
      'one-off title',
      'one-off prompt',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const created = await tasksTitled('one-off title');
    expect(created).toHaveLength(1);
    const task = created[0] as WireTask;
    expect(task.machine).toBe(machine.name);
    expect(task.directoryId).toBe(directoryId);
    expect(task.projectId).toBe(defaultProject);
    expect(task.scheduleId).toBeNull();
    expect(
      await key.open(
        bindings.input({ origin: { task: task.id }, creator: 'user' }),
        task.input ?? '',
      ),
    ).toBe('one-off prompt');
    const due = Date.parse(task.notBefore ?? '');
    expect(Math.abs(due - (Date.now() + HOUR_MS))).toBeLessThan(SLACK_MS);
  });

  it('[cli-036] creates a repeating schedule bound to this machine, an allowed directory and the project', async () => {
    await prepare();
    const result = await board([
      'schedule',
      '--every',
      '2h',
      '--title',
      'repeating title',
      'repeating prompt',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const created = await scheduleTitled('repeating title');
    expect(created).toHaveLength(1);
    const schedule = created[0] as WireSchedule;
    expect(schedule.everyMs).toBe(2 * HOUR_MS);
    expect(schedule.cron).toBeNull();
    expect(schedule.after).toBeNull();
    expect(schedule.machine).toBe(machine.name);
    expect(schedule.directoryId).toBe(directoryId);
    expect(schedule.projectId).toBe(defaultProject);
    expect(schedule.paused).toBe(false);
    expect(
      await key.open(
        bindings.input({ origin: { schedule: schedule.id }, creator: 'user' }),
        schedule.input,
      ),
    ).toBe('repeating prompt');
  });

  it('[cli-036] a repeating schedule takes several crons with their timezone', async () => {
    await prepare();
    const result = await board([
      'schedule',
      '--cron',
      '0 9 * * 1',
      '--cron',
      '30 17 * * 5',
      '--title',
      'cron title',
      'cron prompt',
    ]);
    expect(result.code, result.stderr).toBe(0);
    const created = await scheduleTitled('cron title');
    expect(created).toHaveLength(1);
    const schedule = created[0] as WireSchedule;
    expect(schedule.everyMs).toBeNull();
    expect([schedule.cron, ...(schedule.moreCrons ?? [])].sort()).toEqual([
      '0 9 * * 1',
      '30 17 * * 5',
    ]);
    expect(schedule.timezone).toBeTruthy();
  });

  it('[cli-036] a key answers created, exists, rescheduled and requeued and always exits 0', async () => {
    await prepare();
    const dedupeKey = `dedupe-${randomBytes(4).toString('hex')}`;
    const title = `keyed ${dedupeKey}`;
    const keyed = (extra: readonly string[]) =>
      board(['schedule', '--key', dedupeKey, '--title', title, ...extra, 'keyed prompt']);

    const firstAt = new Date(Math.ceil((Date.now() + HOUR_MS) / 60_000) * 60_000);
    const secondAt = new Date(firstAt.getTime() + HOUR_MS);

    const created = await keyed(['--at', firstAt.toISOString()]);
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toMatch(/\bcreated\b/);
    const first = await tasksTitled(title);
    expect(first).toHaveLength(1);
    const id = (first[0] as WireTask).id;
    expect(Date.parse((first[0] as WireTask).notBefore ?? '')).toBe(firstAt.getTime());

    const exists = await keyed(['--at', firstAt.toISOString()]);
    expect(exists.code, exists.stderr).toBe(0);
    expect(exists.stdout).toMatch(/\bexists\b/);
    expect((await tasksTitled(title)).map((task) => task.id)).toEqual([id]);

    const rescheduled = await keyed(['--at', secondAt.toISOString()]);
    expect(rescheduled.code, rescheduled.stderr).toBe(0);
    expect(rescheduled.stdout).toMatch(/\brescheduled\b/);
    const moved = await tasksTitled(title);
    expect(moved.map((task) => task.id)).toEqual([id]);
    expect(Date.parse((moved[0] as WireTask).notBefore ?? '')).toBe(secondAt.getTime());

    setClockOffset(harness.board, 3 * 3600);
    try {
      const claimed = await machine.ok('machine.claim-task', { id, machine: machine.name });
      await machine.ok('machine.update-task', {
        id,
        status: 'needs-me',
        expect: 'running',
        ...(claimed.run === undefined ? {} : { run: claimed.run }),
      });
    } finally {
      setClockOffset(harness.board, 0);
    }

    const requeued = await keyed(['--version', '2']);
    expect(requeued.code, requeued.stderr).toBe(0);
    expect(requeued.stdout).toMatch(/\brequeued\b/);
    const again = await tasksTitled(title);
    expect(again.map((task) => task.id)).toEqual([id]);
    expect((again[0] as WireTask).status).toBe('todo');
  });

  const exclusions: readonly (readonly [string, readonly string[]])[] = [
    ['--polish with --hold', ['--polish', '--hold']],
    ['--polish with --in', ['--polish', '--in', '1h']],
    ['--polish with --at', ['--polish', '--at', '2099-01-01T00:00:00Z']],
    ['--polish with --every', ['--polish', '--every', '1h']],
    ['--polish with --cron', ['--polish', '--cron', '0 * * * *']],
    ['--key with --every', ['--key', 'excluded', '--every', '1h']],
    ['--key with --cron', ['--key', 'excluded', '--cron', '0 * * * *']],
    ['--key with --polish', ['--key', 'excluded', '--polish']],
    ['--key with --hold', ['--key', 'excluded', '--hold']],
    ['--key with --backlog', ['--key', 'excluded', '--backlog']],
    ['--every with --cron', ['--every', '1h', '--cron', '0 * * * *']],
  ];

  it('[cli-036] the documented option exclusions exit non-zero with a message and create nothing', async () => {
    await prepare();
    const tasksBefore = (await tasks()).length;
    const schedulesBefore = (await schedules()).length;
    for (const [label, flags] of exclusions) {
      const result = await board(['schedule', ...flags, 'excluded prompt']);
      expect(result.code, `${label} must exit non-zero`).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`.trim(), `${label} must say why`).not.toBe('');
    }
    expect((await tasks()).length).toBe(tasksBefore);
    expect((await schedules()).length).toBe(schedulesBefore);
  });
});

describe('[api-077] an after schedule', () => {
  const harness = useBoard({ parts: ['api', 'cli'], features: ['schedules'], auth: 'no-login' });

  interface Pair {
    readonly machine: EnrolledMachine;
    readonly user: BoardUser;
    readonly key: UnlockedKey;
    readonly upstream: string;
    readonly downstream: string;
    readonly firstUpstreamTask: string;
  }

  const draft = async (
    key: UnlockedKey,
    id: string,
    rule: { everyMs: number } | { after: { scheduleId: string; delayMs: number } },
  ) => ({
    id,
    title: await key.seal(bindings.title({ schedule: id }), `schedule ${id}`),
    input: await key.seal(bindings.input({ origin: { schedule: id }, creator: 'user' }), 'prompt'),
    autoDone: true,
    ...rule,
  });

  const start = async (): Promise<Pair> => {
    const { board } = harness;
    const user = await noLoginUser(board);
    const key = await unlockedKey(board, user);
    const machine = await enrolledMachine(board, user, {
      key,
      name: randomId('after'),
      init: false,
    });
    const upstream = randomId('up');
    const downstream = randomId('down');
    const added = await machine.ok(
      'machine.add-schedule',
      await draft(key, upstream, { everyMs: HOUR_MS }),
    );
    expect(added.task).not.toBeNull();
    await machine.ok(
      'machine.add-schedule',
      await draft(key, downstream, { after: { scheduleId: upstream, delayMs: 0 } }),
    );
    return {
      machine,
      user,
      key,
      upstream,
      downstream,
      firstUpstreamTask: (added.task as WireTask).id,
    };
  };

  const occurrences = async (pair: Pair): Promise<WireTask[]> =>
    (await pair.machine.ok('machine.list-tasks', { all: true })).tasks.filter(
      (task) => task.scheduleId === pair.downstream,
    );

  const run = async (pair: Pair): Promise<string | undefined> => {
    const claimed = await pair.machine.ok('machine.claim-task', {
      id: pair.firstUpstreamTask,
      machine: pair.machine.name,
    });
    expect(claimed.status).toBe('running');
    return claimed.run;
  };

  const move = (
    pair: Pair,
    run: string | undefined,
    status: 'needs-me' | 'done',
    from: 'running' | null = 'running',
  ) =>
    pair.machine.call('machine.update-task', {
      id: pair.firstUpstreamTask,
      status,
      ...(from === null ? {} : { expect: from }),
      ...(run === undefined ? {} : { run }),
    });

  const settleWindow = () => new Promise((resolve) => setTimeout(resolve, 2_000));

  it('[api-077] fires once when the upstream task moves from running to needs-me', async () => {
    const pair = await start();
    expect(await occurrences(pair)).toHaveLength(0);
    const runId = await run(pair);
    expect((await move(pair, runId, 'needs-me')).ok).toBe(true);
    await eventually(
      () => occurrences(pair),
      (found) => found.length >= 1,
      {
        label: 'the after schedule fires',
      },
    );
    expect(await occurrences(pair)).toHaveLength(1);
  });

  it('[api-077] fires once when the upstream task moves from running to done', async () => {
    const pair = await start();
    const runId = await run(pair);
    expect((await move(pair, runId, 'done')).ok).toBe(true);
    await eventually(
      () => occurrences(pair),
      (found) => found.length >= 1,
      {
        label: 'the after schedule fires',
      },
    );
    expect(await occurrences(pair)).toHaveLength(1);
  });

  it('[api-077] a second transition into the same state for the same run does not fire again', async () => {
    const pair = await start();
    const runId = await run(pair);
    expect((await move(pair, runId, 'needs-me')).ok).toBe(true);
    await eventually(
      () => occurrences(pair),
      (found) => found.length >= 1,
      {
        label: 'the after schedule fires',
      },
    );
    await move(pair, runId, 'needs-me', null);
    await move(pair, runId, 'needs-me', null);
    await settleWindow();
    expect(await occurrences(pair)).toHaveLength(1);
  });

  it('[api-077] fires once more for running to done on a second run', async () => {
    const pair = await start();
    const firstRun = await run(pair);
    expect((await move(pair, firstRun, 'needs-me')).ok).toBe(true);
    const [firstOccurrence] = await eventually(
      () => occurrences(pair),
      (found) => found.length >= 1,
      { label: 'the after schedule fires for needs-me' },
    );
    await pair.user.ok('client.tasks.move', {
      id: (firstOccurrence as WireTask).id,
      status: 'backlog',
    });

    await pair.user.ok('client.tasks.reply', {
      id: pair.firstUpstreamTask,
      message: {
        body: await pair.key.seal(
          bindings.note({
            field: 'note.body',
            taskId: pair.firstUpstreamTask,
            author: 'user',
            kind: 'comment',
          }),
          'again',
        ),
      },
      resume: true,
    });
    const secondRun = await run(pair);
    expect(secondRun).not.toBe(firstRun);
    expect((await move(pair, secondRun, 'done')).ok).toBe(true);
    await eventually(
      () => occurrences(pair),
      (found) => found.length >= 2,
      {
        label: 'the after schedule fires for done',
      },
    );
    await move(pair, secondRun, 'done', null);
    await settleWindow();
    expect(await occurrences(pair)).toHaveLength(2);
  });
});
