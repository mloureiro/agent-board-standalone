import { mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bindings } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import {
  StreamBudget,
  STREAM_MAX_BYTES,
  STREAM_MAX_EVENTS,
  STREAM_WINDOW_MS,
} from '../src/watch/stream-limit.js';
import { finishWatch } from '../src/watch/finish.js';
import { WatchStore, newWatchId, type WatchDef } from '../src/watch/store.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const PR = 'https://github.com/acme/app/pull/17741';
const HEAD = 'a'.repeat(40);

async function running(options: Parameters<typeof rig>[0] = {}) {
  const made = await rig(options);
  await made.stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
  return made;
}

const gh = (file: string, args: readonly string[]) =>
  args[0] === 'api'
    ? { code: 0, stdout: 'octocat\n' }
    : file === 'gh'
      ? { code: 0, stdout: JSON.stringify({ url: PR, headRefOid: HEAD }) }
      : { code: 1, stdout: '' };

async function published(stub: Awaited<ReturnType<typeof rig>>['stub']) {
  return JSON.parse(
    await stub.open(bindings.watches('taskAAAA'), stub.watches.get('taskAAAA') ?? ''),
  ) as {
    watches: { name: string; kind: string; label: string; status: string }[];
    pendingEvents: number;
  };
}

describe('rumo watch, watches and unwatch', () => {
  it('[cli-020] starts a CI watch on the PR the task reported, from gh, and publishes it without the command', async () => {
    const { stub, cli } = await running({ exec: gh });
    await cli.run('pr', 'taskAAAA', PR);
    cli.reset();
    expect(
      await cli.run('watch', 'taskAAAA', '--ci', '--required', '--ignore', 'policy-bot*'),
    ).toBe(0);
    expect(cli.test.execCalls[0]).toMatchObject({
      file: 'gh',
      args: ['pr', 'view', PR, '--json', 'url,headRefOid'],
    });
    expect(cli.stdout()).toContain('watching "ci" on taskAAAA');
    expect(cli.stdout()).toContain('ignoring "policy-bot*"');
    const document = await published(stub);
    expect(document.watches).toMatchObject([
      { name: 'ci', kind: 'ci', label: 'CI #17741 · required' },
    ]);
    cli.reset();
    await cli.run('watches', 'taskAAAA', '--json');
    expect(JSON.parse(cli.stdout())).toMatchObject([
      { name: 'ci', source: { kind: 'ci', pr: PR, required: true, ignore: ['policy-bot*'] } },
    ]);
  });

  it('[cli-020] starts review, merged, timer, command and stream watches and lists them', async () => {
    const { stub, cli } = await running({ exec: gh });
    expect(await cli.run('watch', 'taskAAAA', '--pr-review', '17741')).toBe(0);
    expect(await cli.run('watch', 'taskAAAA', '--pr-merged', PR)).toBe(0);
    expect(await cli.run('watch', 'taskAAAA', '--in', '30m')).toBe(0);
    expect(
      await cli.run(
        'watch',
        'taskAAAA',
        '--name',
        'health',
        '--every',
        '1m',
        '--',
        'curl -fsS http://h/health',
      ),
    ).toBe(0);
    expect(
      await cli.run('watch', 'taskAAAA', '--name', 'log', '--stream', '--', 'tail', '-f', 'a file'),
    ).toBe(0);
    expect((await published(stub)).watches.map((watch) => [watch.name, watch.kind])).toEqual([
      ['health', 'command'],
      ['log', 'stream'],
      ['pr-merged', 'pr-merged'],
      ['review', 'pr-review'],
      ['timer', 'timer'],
    ]);
    cli.reset();
    expect(await cli.run('watches', 'taskAAAA')).toBe(0);
    expect(cli.stdout()).toContain("stream: tail -f 'a file'");
    expect(cli.stdout()).toContain('every 1m: curl -fsS http://h/health');
  });

  it('[cli-020] the same name again replaces the open watch', async () => {
    const { cli } = await running();
    await cli.run('watch', 'taskAAAA', '--in', '30m');
    cli.reset();
    await cli.run('watch', 'taskAAAA', '--in', '1h');
    expect(cli.stdout()).toContain('it replaced the open watch "timer"');
  });

  it('[cli-020] command and stream watches are refused in a restricted run', async () => {
    const { cli } = await running({ env: { RUMO_RESTRICTED: '1' }, exec: gh });
    expect(await cli.run('watch', 'taskAAAA', '--name', 'x', '--', 'true')).toBe(2);
    expect(await cli.run('watch', 'taskAAAA', '--name', 'x', '--stream', '--', 'true')).toBe(2);
    expect(await cli.run('watch', 'taskAAAA', '--in', '5m')).toBe(0);
    expect(await cli.run('watch', 'taskAAAA', '--ci', PR)).toBe(0);
  });

  it('[cli-020] a run watches its own task only, and only a running or waiting task of this machine', async () => {
    const own = await running({ env: { RUMO_TASK: 'taskAAAA' } });
    await own.stub.addTask({ id: 'taskBBBB', status: 'running', machine: 'test-machine' });
    expect(await own.cli.run('watch', 'taskBBBB', '--in', '5m')).toBe(2);
    const { stub, cli } = await running();
    await stub.addTask({ id: 'taskDONE', status: 'done', machine: 'test-machine' });
    await stub.addTask({ id: 'taskELSE', status: 'running', machine: 'another' });
    expect(await cli.run('watch', 'taskDONE', '--in', '5m')).toBe(2);
    expect(await cli.run('watch', 'taskELSE', '--in', '5m')).toBe(2);
  });

  it('[cli-020] refuses wrong flag combinations and a gh that cannot read the PR', async () => {
    const { cli } = await running({ exec: () => ({ code: 1, stdout: '' }) });
    const refused = [
      ['--ci', '--pr-review'],
      [],
      ['--required', '--in', '5m'],
      ['--ignore', 'x', '--in', '5m'],
      ['--in', '5m', '--at', '09:00'],
      ['--in', '5m', '--every', '1m'],
      ['--ci', '--every', '1m'],
      ['--in', '8d'],
      ['--ci', '--timeout', '8d'],
      ['--stream'],
      ['--name', 'x', '--stream', '--every', '1m', '--', 'true'],
      ['--name', 'x', '--every', '10s', '--', 'true'],
      ['--', 'true'],
      ['--name', 'Bad Name', '--in', '5m'],
    ];
    for (const flags of refused) expect(await cli.run('watch', 'taskAAAA', ...flags)).toBe(2);
    expect(await cli.run('watch', 'taskAAAA', '--ci', '17741')).toBe(2);
    expect(await cli.run('watch', 'taskAAAA', '--ci', 'not a pr')).toBe(2);
    expect(await cli.run('watch', 'taskAAAA', '--ci')).toBe(2);
  });

  it('[cli-020] unwatch stops one watch and says which are open when the name is wrong', async () => {
    const { stub, cli } = await running();
    await cli.run('watch', 'taskAAAA', '--in', '30m');
    await cli.run('watch', 'taskAAAA', '--in', '30m', '--name', 'second');
    expect(await cli.run('unwatch', 'taskAAAA', 'nope')).toBe(2);
    expect(cli.stderr()).toContain('open: "second", "timer"');
    expect(await cli.run('unwatch', 'taskAAAA', 'timer')).toBe(0);
    expect((await published(stub)).watches.map((watch) => watch.name)).toEqual(['second']);
    expect(await cli.run('unwatch', 'taskAAAA', 'second')).toBe(0);
    expect(stub.watches.get('taskAAAA')).toBeNull();
    expect(await cli.run('unwatch', 'taskAAAA', 'second')).toBe(2);
    expect(cli.stderr()).toContain('has no open watch');
  });

  it('[cli-020] [cli-005] stores nothing on --dry-run and skips publishing on a server without the watches feature', async () => {
    const { stub, cli } = await running();
    expect(await cli.run('--dry-run', 'watch', 'taskAAAA', '--in', '5m')).toBe(0);
    expect(cli.stdout()).toContain('DRY store watch "timer"');
    expect(stub.commands()).not.toContain('set-watches');
    const old = await rig({ board: { features: ['projects'] } });
    await old.stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await old.cli.run('watch', 'taskAAAA', '--in', '5m')).toBe(1);
    expect(old.cli.stderr()).toContain('lacks the feature "watches"');
  });
});

describe('a stream watch budget', () => {
  it('[cli-021] stops the stream after 50 events in 10 minutes', () => {
    const budget = new StreamBudget();
    const results = Array.from({ length: STREAM_MAX_EVENTS + 1 }, (_, index) =>
      budget.record(index * 1000, 10),
    );
    expect(results.slice(0, STREAM_MAX_EVENTS).every((result) => result === 'ok')).toBe(true);
    expect(results.at(-1)).toBe('exceeded');
  });

  it('[cli-021] stops the stream after 20 KB in 10 minutes', () => {
    const budget = new StreamBudget();
    expect(budget.record(0, STREAM_MAX_BYTES)).toBe('ok');
    expect(budget.record(1000, 1)).toBe('exceeded');
  });

  it('[cli-021] forgets what happened more than 10 minutes ago', () => {
    const budget = new StreamBudget();
    for (let index = 0; index < STREAM_MAX_EVENTS; index++) budget.record(0, 100);
    expect(budget.record(STREAM_WINDOW_MS - 1, 100)).toBe('exceeded');
    const later = new StreamBudget();
    for (let index = 0; index < STREAM_MAX_EVENTS; index++) later.record(0, 100);
    expect(later.record(STREAM_WINDOW_MS, 100)).toBe('ok');
  });
});

describe('finishing a watch', () => {
  const def = (): WatchDef => ({
    id: newWatchId(),
    name: 'ci',
    task: 'taskAAAA',
    createdAt: '2026-01-01T00:00:00.000Z',
    deadline: '2026-01-01T02:00:00.000Z',
    everyMs: 30_000,
    source: { kind: 'timer' },
  });

  function store(): WatchStore {
    return new WatchStore(mkdtempSync(path.join(os.tmpdir(), 'board-watch-')));
  }

  it('[cli-022] exactly one of several writers records the event', () => {
    const watches = store();
    const open = def();
    watches.write(open);
    const winners = Array.from({ length: 8 }, (_, index) =>
      finishWatch(watches, open, { kind: 'event', text: `writer ${index}` }, new Date()),
    ).filter((event) => event !== undefined);
    expect(winners).toHaveLength(1);
    expect(watches.events('taskAAAA')).toHaveLength(1);
    expect(watches.list('taskAAAA').defs).toEqual([]);
  });

  it('[cli-022] a stale writer that holds an older watch of the same name loses', () => {
    const watches = store();
    const older = def();
    const newer = def();
    watches.write(older);
    watches.write(newer);
    expect(
      finishWatch(watches, older, { kind: 'event', text: 'stale' }, new Date()),
    ).toBeUndefined();
    expect(watches.list('taskAAAA').defs.map((open) => open.id)).toEqual([newer.id]);
    expect(watches.events('taskAAAA')).toEqual([]);
  });

  it('[cli-022] a claimed watch is gone for every other claimer and leaves no stray file', () => {
    const watches = store();
    const open = def();
    watches.write(open);
    const claim = watches.claim('taskAAAA', 'ci');
    expect(claim?.def.id).toBe(open.id);
    expect(watches.claim('taskAAAA', 'ci')).toBeUndefined();
    claim?.done();
    const directory = path.join(watches.watchesDir, 'taskAAAA');
    expect(readdirSync(directory)).toEqual([]);
  });
});
