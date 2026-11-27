import { bindings, blindIndex } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import { type ApiStub } from './support/api-stub.js';
import { tmpDir } from './support/files.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const HOUR_MS = 3_600_000;

async function placed(config?: string) {
  const work = tmpDir();
  const made = await rig({ cwd: work, ...(config === undefined ? {} : { config }) });
  expect(await made.cli.run('dirs', 'add', '--no-repo')).toBe(0);
  made.cli.reset();
  return { ...made, work };
}

async function titleOf(stub: ApiStub, id: string, wire: string): Promise<string> {
  return stub.open(bindings.title({ task: id }), wire);
}

async function onlyTask(stub: ApiStub) {
  const tasks = [...stub.tasks.values()];
  expect(tasks).toHaveLength(1);
  return tasks[0] as NonNullable<(typeof tasks)[number]>;
}

describe('rumo schedule', () => {
  it('[cli-036] creates a one-off task bound to this machine, the listed directory and the host project', async () => {
    const { stub, cli } = await placed(`machine: test-machine\nproject: ${PROJECT}\n`);
    expect(
      await cli.run('schedule', '--in', '1h', '--title', 'one-off title', 'one-off', 'prompt'),
    ).toBe(0);
    const task = await onlyTask(stub);
    const [directory] = [...stub.directories.values()];
    expect(task).toMatchObject({
      machine: 'test-machine',
      directoryId: directory?.id,
      projectId: PROJECT,
      createdBy: 'user',
      status: 'todo',
      scheduleId: null,
    });
    expect(await titleOf(stub, task.id, task.title)).toBe('one-off title');
    expect(
      await stub.open(bindings.input({ origin: { task: task.id }, creator: 'user' }), task.input),
    ).toBe('one-off prompt');
    expect(Math.abs(Date.parse(task.notBefore ?? '') - (Date.now() + HOUR_MS))).toBeLessThan(
      60_000,
    );
    expect(cli.stdout()).toMatch(/^scheduled \w+ http/);
  });

  it('[cli-036] the title defaults to the first line of the prompt and the options become fields', async () => {
    const { stub, cli } = await placed();
    expect(
      await cli.run(
        'schedule',
        '--priority',
        'high',
        '--model',
        'opus',
        '--effort',
        'low',
        '--lane',
        'fast',
        '--auto-done',
        '--icon',
        '🚀',
        '--label',
        'ops',
        '--label',
        'nightly',
        '--agent',
        'reviewer',
        '--backlog',
        'check the logs\nthen report',
      ),
    ).toBe(0);
    const task = await onlyTask(stub);
    expect(await titleOf(stub, task.id, task.title)).toBe('check the logs');
    expect(task).toMatchObject({
      priority: 'high',
      model: 'opus',
      effort: 'low',
      requestedLane: 'fast',
      autoDone: true,
      status: 'backlog',
    });
    expect(await stub.open(bindings.icon({ task: task.id }), task.icon ?? '')).toBe('🚀');
    expect(
      JSON.parse(await stub.open(bindings.labels({ task: task.id }), task.labels ?? '')),
    ).toEqual(['ops', 'nightly']);
    expect(await stub.open(bindings.agent({ task: task.id }), task.agent ?? '')).toBe('reviewer');
    expect(
      await stub.open(
        bindings.input({ origin: { task: task.id }, creator: 'user', agent: 'reviewer' }),
        task.input,
      ),
    ).toBe('check the logs\nthen report');
  });

  it('[cli-036] --hold lands the task in needs-me', async () => {
    const { stub, cli } = await placed();
    expect(await cli.run('schedule', '--hold', 'wait for me')).toBe(0);
    expect((await onlyTask(stub)).status).toBe('needs-me');
  });

  it('[cli-036] a repeating schedule is bound to this machine, the directory and the project', async () => {
    const { stub, cli } = await placed();
    expect(
      await cli.run('schedule', '--every', '2h', '--title', 'repeating title', 'repeating prompt'),
    ).toBe(0);
    const [schedule] = [...stub.schedules.values()];
    const [directory] = [...stub.directories.values()];
    expect(schedule).toMatchObject({
      everyMs: 2 * HOUR_MS,
      cron: null,
      after: null,
      machine: 'test-machine',
      directoryId: directory?.id,
      paused: false,
    });
    expect(
      await stub.open(bindings.title({ schedule: schedule?.id ?? '' }), schedule?.title ?? ''),
    ).toBe('repeating title');
    expect(
      await stub.open(
        bindings.input({ origin: { schedule: schedule?.id ?? '' }, creator: 'user' }),
        schedule?.input ?? '',
      ),
    ).toBe('repeating prompt');
    expect(cli.stdout()).toMatch(/scheduled repeat \w+: every 2h; first run/);
  });

  it('[cli-036] several crons are sent with the time zone, the first as cron and the rest as moreCrons', async () => {
    const { stub, cli } = await placed();
    expect(
      await cli.run(
        'schedule',
        '--cron',
        '0 9 * * 1',
        '--cron',
        '30 17 * * 5',
        '--times',
        '4',
        'cron prompt',
      ),
    ).toBe(0);
    const [schedule] = [...stub.schedules.values()];
    expect(schedule).toMatchObject({
      everyMs: null,
      cron: '0 9 * * 1',
      moreCrons: ['30 17 * * 5'],
      remaining: 4,
    });
    expect(schedule?.timezone).toBeTruthy();
  });

  it('[cli-036] --after waits for another schedule, named by the start of its id, and makes no task', async () => {
    const { stub, cli } = await placed();
    await cli.run('schedule', '--every', '1d', 'upstream');
    const [upstream] = [...stub.schedules.values()];
    cli.reset();
    expect(
      await cli.run(
        'schedule',
        '--after',
        (upstream?.id ?? '').slice(0, 5),
        '--delay',
        '10m',
        'downstream',
      ),
    ).toBe(0);
    const downstream = [...stub.schedules.values()].find(
      (schedule) => schedule.id !== upstream?.id,
    );
    expect(downstream?.after).toEqual({ scheduleId: upstream?.id, delayMs: 600_000 });
    expect(cli.stdout()).toContain('its first task is made when a task of that schedule finishes');
    expect(await cli.run('schedule', '--after', 'nope', 'x')).toBe(2);
  });

  it('[cli-036] a repeat needs a listed directory of this machine', async () => {
    const { cli } = await rig({ cwd: tmpDir() });
    expect(await cli.run('schedule', '--every', '1h', 'prompt')).toBe(2);
    expect(cli.stderr()).toContain('rumo dirs add');
  });

  it('[cli-036] a key answers created, exists, rescheduled and requeued, and always exits 0', async () => {
    const { stub, cli } = await placed();
    const keyed = (...extra: string[]) =>
      cli.run('schedule', '--key', 'k1', '--title', 'keyed', ...extra, 'keyed prompt');
    const first = new Date(Math.ceil((Date.now() + HOUR_MS) / 60_000) * 60_000);
    const second = new Date(first.getTime() + HOUR_MS);

    expect(await keyed('--at', first.toISOString())).toBe(0);
    expect(cli.stdout()).toMatch(/^created \w+ http/);
    const task = await onlyTask(stub);
    expect(Date.parse(task.notBefore ?? '')).toBe(first.getTime());

    cli.reset();
    expect(await keyed('--at', first.toISOString())).toBe(0);
    expect(cli.stdout()).toContain('exists');

    cli.reset();
    expect(await keyed('--at', second.toISOString())).toBe(0);
    expect(cli.stdout()).toMatch(/^rescheduled /);
    expect(Date.parse(stub.tasks.get(task.id)?.notBefore ?? '')).toBe(second.getTime());

    stub.patch(task.id, { status: 'needs-me', notBefore: null });
    cli.reset();
    expect(await keyed('--version', '2')).toBe(0);
    expect(cli.stdout()).toMatch(/^requeued /);
    expect(stub.tasks.get(task.id)).toMatchObject({
      status: 'todo',
      next: 'fresh',
      head: await blindIndex(stub.keys, '2'),
    });
    expect(stub.tasks.size).toBe(1);

    cli.reset();
    expect(await keyed('--version', '2')).toBe(0);
    expect(cli.stdout()).toContain('(same-version)');
    stub.patch(task.id, { status: 'running' });
    cli.reset();
    expect(await keyed('--version', '3')).toBe(0);
    expect(cli.stdout()).toContain('(busy)');
    stub.patch(task.id, { closed: true });
    cli.reset();
    expect(await keyed('--version', '4')).toBe(0);
    expect(cli.stdout()).toContain('(closed)');
  });

  it('[cli-036] a key task of another agent is left as it is', async () => {
    const { stub, cli } = await placed();
    await cli.run('schedule', '--key', 'k2', '--agent', 'reviewer', 'first');
    const task = await onlyTask(stub);
    stub.patch(task.id, { status: 'done' });
    cli.reset();
    expect(await cli.run('schedule', '--key', 'k2', '--version', '9', 'again')).toBe(0);
    expect(cli.stdout()).toContain('(other-agent)');
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
    ['--hold with --backlog', ['--hold', '--backlog']],
    ['--in with --at', ['--in', '1h', '--at', '2099-01-01T00:00:00Z']],
    ['--in with --hold', ['--in', '1h', '--hold']],
    ['--times with --until', ['--every', '1h', '--times', '2', '--until', '2099-01-01T00:00:00Z']],
    ['--times without a repeat', ['--times', '2']],
    ['--max-concurrent without a repeat', ['--max-concurrent', '2']],
    ['--delay without --after', ['--delay', '1h']],
    ['--version without --key', ['--version', '2']],
    ['--after with --every', ['--after', 'abc', '--every', '1h']],
    ['a bad cron', ['--cron', '* * *']],
  ];

  it.each(exclusions)(
    '[cli-036] the exclusion %s exits 2 with a message and creates nothing',
    async (label, flags) => {
      const { stub, cli } = await placed();
      const code = await cli.run('schedule', ...flags, 'excluded prompt');
      expect(code, label).toBe(2);
      expect(cli.stderr().trim()).not.toBe('');
      expect(stub.tasks.size).toBe(0);
      expect(stub.schedules.size).toBe(0);
      expect(stub.commands()).not.toContain('add-task');
    },
  );

  it('[cli-036] --polish parks the task in backlog and queues a child that polishes its prompt', async () => {
    const { stub, cli } = await placed();
    expect(await cli.run('schedule', '--polish', '--title', 'rough', 'a rough prompt')).toBe(0);
    const tasks = [...stub.tasks.values()];
    expect(tasks).toHaveLength(2);
    const parent = tasks.find((task) => task.status === 'backlog');
    const child = tasks.find((task) => task.status === 'todo');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(cli.stdout()).toContain('queued polish');
    expect(
      await stub.open(
        bindings.input({ origin: { task: child?.id ?? '' }, creator: 'user' }),
        child?.input ?? '',
      ),
    ).toContain(`rumo polish ${parent?.id}`);
  });

  it('[cli-036] a prompt ending in --dry-run is refused, and -- starts a prompt with dashes', async () => {
    const { stub, cli } = await placed();
    expect(await cli.run('schedule', 'run the thing', '--dry-run')).toBe(2);
    expect(stub.tasks.size).toBe(0);
    expect(await cli.run('schedule', '--', '--force the issue')).toBe(0);
    expect((await onlyTask(stub)).id).toBeTruthy();
  });

  it('[cli-036] flags after the first word belong to the prompt', async () => {
    const { stub, cli } = await placed();
    expect(await cli.run('schedule', 'do the thing', '--every', '1h')).toBe(0);
    expect(stub.schedules.size).toBe(0);
    const task = await onlyTask(stub);
    expect(
      await stub.open(bindings.input({ origin: { task: task.id }, creator: 'user' }), task.input),
    ).toBe('do the thing --every 1h');
  });

  it('[cli-036] is refused inside a run, prints DRY on a dry run and --json prints the ids', async () => {
    const inRun = await rig({ env: { RUMO_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('schedule', 'x')).toBe(2);

    const { stub, cli } = await placed();
    expect(await cli.run('schedule', '--dry-run', 'dry prompt')).toBe(0);
    expect(cli.stdout()).toContain('DRY add-task');
    expect(stub.tasks.size).toBe(0);
    cli.reset();
    expect(await cli.run('schedule', '--json', 'json prompt')).toBe(0);
    const printed = JSON.parse(cli.stdout()) as { id: string; url: string };
    expect(stub.tasks.has(printed.id)).toBe(true);
  });

  it('[cli-036] the host default project receives the task without --project', async () => {
    const { stub, cli } = await placed();
    await cli.run('projects', 'default', PROJECT);
    expect(await cli.run('schedule', '--backlog', 'a scheduled prompt')).toBe(0);
    expect((await onlyTask(stub)).projectId).toBe(PROJECT);
  });
});
