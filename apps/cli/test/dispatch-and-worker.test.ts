import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bindings } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/commands/context.js';
import { loadDispatchConfig } from '../src/dispatch/config.js';
import { runDispatch } from '../src/dispatch/run.js';
import { acquireTickLock } from '../src/dispatch/lock.js';
import { runListener } from '../src/dispatch/listen.js';
import {
  decideStale,
  nextPauseAt,
  planPauses,
  planStarts,
  type LaneRun,
} from '../src/dispatch/plan.js';
import { reachedWindows } from '../src/dispatch/usage.js';
import { feedIdOf } from '../src/feeds/ids.js';
import { readFeedState } from '../src/feeds/store.js';
import { createRunFiles, systemProcessOps } from '../src/shutdown/index.js';
import { openSession } from '../src/transport/session.js';
import { writePendingMigration } from '../src/update/migrations.js';
import { runWatchUnit } from '../src/watch/run.js';
import { scanWatches, type ScanDeps } from '../src/watch/scan.js';
import { WatchStore, type WatchDef } from '../src/watch/store.js';
import { runWorker } from '../src/worker/run.js';
import type { ApiStub } from './support/api-stub.js';
import { useRig, type Rig } from './support/harness.js';
import { tmpDir } from './support/files.js';

const rig = useRig();
const PROCESS = { RUMO_WORKER_SPAWN: 'process' } as const;

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function contextOf(rigged: Rig) {
  return buildContext(rigged.cli.test.rt, {});
}

async function noteTexts(stub: ApiStub, taskId: string): Promise<string[]> {
  return Promise.all(
    (stub.notes.get(taskId) ?? []).map((note) =>
      note.author === 'server'
        ? Promise.resolve(note.body)
        : stub.open(
            bindings.note({ field: 'note.body', taskId, author: note.author, kind: note.kind }),
            note.body,
          ),
    ),
  );
}

function ticksSeen(stub: ApiStub): number {
  return stub.seen.filter((request) => request.path === '/api/machine/version').length;
}

function future(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

const lane = (name: string, borrowed = false, startedMinutesAgo = 0): LaneRun => ({
  task: `t-${name}-${borrowed ? 'b' : 'o'}-${startedMinutesAgo}`,
  lane: name,
  borrowed,
  startedAt: new Date(Date.now() - startedMinutesAgo * 60_000),
  pauseRequested: false,
});

const LANES = [
  { name: 'deep', slots: 1, default: false },
  { name: 'quick', slots: 2, default: true },
] as const;

describe('lane planning', () => {
  it('[cli-067] every lane takes its own work first, then lanes with free slots borrow', () => {
    const starts = planStarts({
      lanes: LANES,
      running: [],
      candidates: [
        { id: 'a', ownLane: 'deep' },
        { id: 'b', ownLane: 'deep' },
        { id: 'c', ownLane: 'deep' },
        { id: 'd', ownLane: 'quick' },
      ],
    });
    expect(starts).toEqual([
      { task: 'a', lane: 'deep', borrowed: false },
      { task: 'd', lane: 'quick', borrowed: false },
      { task: 'b', lane: 'quick', borrowed: true },
    ]);
  });

  it('[cli-067] a full lane with its own work waiting pauses the borrowed run that started last, after the configured minutes', () => {
    const own = lane('deep');
    const early = lane('deep', true, 20);
    const late = lane('deep', true, 8);
    const input = {
      lanes: [{ name: 'deep', slots: 3, default: true }],
      running: [own, early, late],
      waitingOwn: new Map([['deep', 1]]),
      now: new Date(),
      pauseAfterMinutes: 5,
    };
    expect(planPauses(input).map((run) => run.task)).toEqual([late.task]);
    expect(planPauses({ ...input, pauseAfterMinutes: 10 }).map((run) => run.task)).toEqual([
      early.task,
    ]);
    expect(planPauses({ ...input, waitingOwn: new Map() })).toEqual([]);
    expect(
      planPauses({ ...input, running: [own, { ...early, pauseRequested: true }, late] }),
    ).toEqual([]);
    const soon = nextPauseAt({ ...input, pauseAfterMinutes: 10 });
    expect(soon?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the sweep decision', () => {
  const base = {
    workerAlive: true,
    startedAt: new Date(Date.now() - 60_000),
    lastActive: undefined,
    now: new Date(),
    limits: { inactivityMinutes: 15, maxRunHours: 6 },
    afterGap: false,
  };

  it('[cli-066] a worker that is gone is stale at once; one that works is not', () => {
    expect(decideStale({ ...base, workerAlive: false })).toMatchObject({
      stale: true,
      stopWorker: false,
    });
    expect(decideStale(base)).toEqual({ stale: false });
  });

  it('[cli-066] quiet time and the maximum run time make a live worker stale, quiet time not after a sleep', () => {
    const quiet = { ...base, startedAt: new Date(Date.now() - 30 * 60_000) };
    expect(decideStale(quiet)).toMatchObject({ stale: true, stopWorker: true });
    expect(decideStale({ ...quiet, afterGap: true })).toEqual({ stale: false });
    const long = { ...base, startedAt: new Date(Date.now() - 7 * 3_600_000) };
    expect(decideStale({ ...long, afterGap: true })).toMatchObject({ stale: true });
  });
});

describe('usage windows', () => {
  it('[cli-068] a window counts only until it resets and only at or over its limit', () => {
    const now = new Date();
    const usage = {
      fiveHour: { utilization: 0.9, resetsAt: future(30), seenAt: now.toISOString() },
      sevenDay: {
        utilization: 0.99,
        resetsAt: new Date(now.getTime() - 1).toISOString(),
        seenAt: '',
      },
    };
    const limits = { fiveHour: 80, sevenDay: 90, priority: 'high' } as const;
    expect(reachedWindows({ limits, usage, now }).map((entry) => entry.window)).toEqual([
      'fiveHour',
    ]);
    expect(reachedWindows({ limits: { ...limits, fiveHour: 95 }, usage, now })).toEqual([]);
  });
});

describe('the tick lock', () => {
  it('[cli-064] a held lock answers exit 75 and a finished tick frees it', async () => {
    const rigged = await rig({ env: PROCESS });
    const { dirs } = contextOf(rigged);
    const lock = acquireTickLock(dirs.run);
    expect(lock).not.toBeNull();
    expect(await rigged.cli.run('internal', 'dispatch')).toBe(75);
    expect(ticksSeen(rigged.stub)).toBe(0);
    lock?.release();
    expect(await rigged.cli.run('internal', 'dispatch')).toBe(0);
    expect(acquireTickLock(dirs.run)).not.toBeNull();
  });

  it('[cli-064] a lock left by a process that is gone is taken over', async () => {
    const rigged = await rig({ env: PROCESS });
    const { dirs } = contextOf(rigged);
    mkdirSync(dirs.run, { recursive: true });
    writeFileSync(path.join(dirs.run, 'dispatch.tick'), '2147483646');
    expect(await rigged.cli.run('internal', 'dispatch')).toBe(0);
  });

  it('[cli-064] a fresh lock whose pid is not written yet is still held', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'board-lock-'));
    writeFileSync(path.join(dir, 'dispatch.tick'), '');
    expect(acquireTickLock(dir)).toBeNull();
  });

  it('[cli-064] a tick that passes its limit answers 124 and frees the lock', async () => {
    const hanging: typeof fetch = (input, init) =>
      String(input).includes('list-tasks')
        ? new Promise<Response>(() => undefined)
        : fetch(input, init);
    const rigged = await rig({ env: PROCESS, fetch: hanging });
    const ctx = contextOf(rigged);
    const exits: number[] = [];
    await expect(
      runDispatch(ctx, {
        limitMs: 100,
        hardStopMs: 50,
        hardExit: (code) => exits.push(code),
      }),
    ).rejects.toMatchObject({ exitCode: 124 });
    expect(rigged.cli.stdout()).toContain('tick stopped after');
    expect(acquireTickLock(ctx.dirs.run)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(exits).toEqual([124]);
  });

  it('[cli-082] the internal commands refuse inside a run and on another platform', async () => {
    const inRun = await rig({ env: { ...PROCESS, RUMO_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('internal', 'dispatch')).toBe(1);
    expect(inRun.cli.stderr()).toContain('cannot run inside a board run');
    const windows = await rig({ env: PROCESS, platform: 'win32' });
    for (const command of ['dispatch', 'listen', 'watch']) {
      windows.cli.reset();
      expect(await windows.cli.run('internal', command)).toBe(1);
      expect(windows.cli.stderr()).toContain('needs Linux or macOS');
    }
  });
});

describe('dispatch tick', () => {
  it('[cli-064] claims a todo task, starts its worker and leaves a start note', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.tasks.get('taskAAAA')).toMatchObject({
      status: 'running',
      machine: 'test-machine',
    });
    expect(cli.test.detachedCalls).toHaveLength(1);
    const call = cli.test.detachedCalls[0];
    expect(call?.args.slice(-3)).toEqual(['internal', 'worker', 'taskAAAA']);
    expect(call?.options.env.RUMO_TASK).toBeUndefined();
    expect(ticksSeen(stub)).toBe(1);
    expect((await noteTexts(stub, 'taskAAAA'))[0]).toMatch(/^rumo: started /);
    expect(cli.stdout()).toContain('STARTED taskAAAA');
  });

  it('[cli-064] claims nothing and asks for nothing while a migration is pending', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    writePendingMigration(contextOf(rigged).dirs.state, {
      from: '0.0.0',
      to: '0.0.1',
      backup: '',
      done: [],
    });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(cli.stdout()).toContain('MIGRATION');
    expect(stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect(ticksSeen(stub)).toBe(0);
  });

  it('[cli-064] skips what is not for this machine and what a user did not start', async () => {
    const { stub, cli } = await rig({ env: PROCESS });
    await stub.addTask({ id: 'agentAAA', status: 'todo', createdBy: 'agent' });
    await stub.addTask({
      id: 'pinnedAA',
      status: 'todo',
      machine: 'other',
      directoryId: '11111111-1111-4111-8111-111111111111',
    });
    await stub.addTask({ id: 'laterAAA', status: 'todo', notBefore: future(60) });
    await stub.addTask({ id: 'readyAAA', status: 'todo' });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.tasks.get('readyAAA')?.status).toBe('running');
    for (const id of ['agentAAA', 'pinnedAA', 'laterAAA']) {
      expect(stub.tasks.get(id)?.status).toBe('todo');
    }
    expect(cli.stdout()).toContain('SKIP agentAAA');
    expect(cli.stdout()).toContain('SKIP pinnedAA pinned to other');
  });

  it('[cli-067] a task takes the lane it asks for, and borrows a free one when its own is full', async () => {
    const rigged = await rig({
      env: PROCESS,
      config:
        'machine: test-machine\nlanes:\n  deep:\n    slots: 1\n  quick:\n    slots: 1\n    default: true\n',
    });
    const { stub, cli } = rigged;
    for (const id of ['deepAAAA', 'deepBBBB']) {
      await stub.addTask({ id, status: 'todo' });
      stub.patch(id, { requestedLane: 'deep' });
    }
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    const { dirs } = contextOf(rigged);
    const record = (task: string) =>
      JSON.parse(readFileSync(path.join(dirs.run, `${task}.lane`), 'utf8')) as Record<
        string,
        unknown
      >;
    expect(record('deepAAAA')).toMatchObject({ lane: 'deep', borrowed: false });
    expect(record('deepBBBB')).toMatchObject({ lane: 'quick', borrowed: true });
    expect(cli.stdout()).toContain('STARTED deepBBBB lane=quick borrowed');
  });

  it('[cli-067] a lane that does not exist here sends the task to the default lane', async () => {
    const { stub, cli } = await rig({ env: PROCESS });
    await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    stub.patch('taskAAAA', { requestedLane: 'nowhere' });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(cli.stdout()).toContain('lane nowhere -> general (no such lane here)');
  });

  it('[cli-068] under a reached limit only work at or above the configured priority starts, and the board is told', async () => {
    const rigged = await rig({
      env: PROCESS,
      config: 'machine: test-machine\nusageLimits:\n  fiveHour: 80\n  priority: high\n',
    });
    const { stub, cli } = rigged;
    writeFileSync(
      path.join(
        (() => {
          const { dirs } = contextOf(rigged);
          mkdirSync(dirs.state, { recursive: true });
          return dirs.state;
        })(),
        'usage.json',
      ),
      JSON.stringify({
        fiveHour: { utilization: 0.9, resetsAt: future(60), seenAt: new Date().toISOString() },
      }),
    );
    await stub.addTask({ id: 'urgentAA', status: 'todo', priority: 'urgent' });
    await stub.addTask({ id: 'lowAAAAA', status: 'todo', priority: 'low' });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.tasks.get('urgentAA')?.status).toBe('running');
    expect(stub.tasks.get('lowAAAAA')?.status).toBe('todo');
    expect(cli.stdout()).toMatch(/HOLD 1 task\(s\) below high: 5-hour usage 90%/);
    const [sent] = stub.bodies('set-usage');
    const document = JSON.parse(
      await stub.open(
        bindings.machineDocument('machine.usage', 'test-machine'),
        sent?.usage as string,
      ),
    ) as {
      heldTasks: string[];
    };
    expect(document.heldTasks).toEqual(['lowAAAAA']);
  });

  it('[web-054] a tick publishes the skills of the Claude config folder as the machine catalog, once', async () => {
    const config = mkdtempSync(path.join(os.tmpdir(), 'board-claude-'));
    mkdirSync(path.join(config, 'skills', 'alpha'), { recursive: true });
    writeFileSync(
      path.join(config, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: The alpha skill\n---\n\nUse alpha.\n',
    );
    mkdirSync(path.join(config, 'skills', 'bare'), { recursive: true });
    writeFileSync(path.join(config, 'skills', 'bare', 'SKILL.md'), 'no front matter\n');
    const { stub, cli } = await rig({ env: { ...PROCESS, CLAUDE_CONFIG_DIR: config } });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    const [sent] = stub.bodies('set-catalog');
    const document = JSON.parse(
      await stub.open(
        bindings.machineDocument('machine.catalog', 'test-machine'),
        sent?.catalog as string,
      ),
    ) as { skills: { name: string; description: string | null }[] };
    expect(document.skills).toEqual([
      { name: 'alpha', description: 'The alpha skill' },
      { name: 'bare', description: null },
    ]);
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.bodies('set-catalog')).toHaveLength(1);
  });

  it('[cli-069] a worker starts as a transient systemd unit on Linux and as a detached process otherwise', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'board-systemd-'));
    chmodSync(
      (() => {
        const file = path.join(bin, 'systemd-run');
        writeFileSync(file, '#!/bin/sh\n');
        return file;
      })(),
      0o755,
    );
    const calls: { file: string; args: readonly string[] }[] = [];
    const unit = await rig({
      platform: 'linux',
      env: {
        PATH: bin,
        SOME_SECRET: 'not-passed',
        RUMO_MARKER: 'passed',
        RUMO_OTHER_SECRET: 'abm_secrettoken',
      },
      exec: (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: '' };
      },
    });
    await unit.stub.addTask({ id: 'taskAAAA', status: 'todo' });
    expect(await unit.cli.run('internal', 'dispatch')).toBe(0);
    expect(unit.cli.test.detachedCalls).toHaveLength(0);
    const call = calls.find((entry) => entry.file === 'systemd-run');
    expect(call?.args).toEqual(
      expect.arrayContaining(['--user', '--collect', '--unit=rumo-default-task-taskAAAA']),
    );
    expect(call?.args.some((arg) => arg.startsWith('--setenv=PATH='))).toBe(true);
    expect(call?.args).toEqual(
      expect.arrayContaining(['--setenv=RUMO_MARKER', '--setenv=RUMO_OTHER_SECRET']),
    );
    expect(call?.args.join(' ')).not.toContain('SOME_SECRET');
    expect(call?.args.join(' ')).not.toContain('abm_secrettoken');
    expect(call?.args.join(' ')).not.toContain('=passed');
    expect(call?.args.slice(-3)).toEqual(['internal', 'worker', 'taskAAAA']);

    const forced = await rig({ platform: 'linux', env: { PATH: bin, ...PROCESS } });
    await forced.stub.addTask({ id: 'taskBBBB', status: 'todo' });
    expect(await forced.cli.run('internal', 'dispatch')).toBe(0);
    expect(forced.cli.test.detachedCalls).toHaveLength(1);
  });

  it('[cli-066] a running task of this machine whose worker is gone goes to needs-me with the log tail in one note', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    await stub.addTask({ id: 'runAAAAA', status: 'running', machine: 'test-machine' });
    mkdirSync(path.join(dirs.state, 'logs'), { recursive: true });
    writeFileSync(path.join(dirs.state, 'logs', 'runAAAAA.log'), 'first\nsweepmarker\nlast\n');
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.tasks.get('runAAAAA')?.status).toBe('needs-me');
    const notes = await noteTexts(stub, 'runAAAAA');
    expect(notes.filter((text) => text.includes('sweepmarker'))).toHaveLength(1);
    expect(notes[0]).toContain('The worker is no longer running.');
    expect(stub.notes.get('runAAAAA')?.[0]).toMatchObject({ author: 'system', kind: 'event' });
  });

  it('[cli-066] a running task whose worker lives, or that was only just started, is left alone', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    await stub.addTask({ id: 'liveAAAA', status: 'running', machine: 'test-machine' });
    await stub.addTask({ id: 'freshAAA', status: 'running', machine: 'test-machine' });
    await stub.addTask({ id: 'otherAAA', status: 'running', machine: 'someone-else' });
    createRunFiles(dirs.run).writeId('liveAAAA', 'pid', process.pid);
    writeFileSync(
      path.join(dirs.run, 'freshAAA.lane'),
      JSON.stringify({ lane: 'general', borrowed: false, startedAt: new Date().toISOString() }),
    );
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    for (const id of ['liveAAAA', 'freshAAA', 'otherAAA']) {
      expect(stub.tasks.get(id)?.status).toBe('running');
    }
  });

  it('[cli-064] a todo task whose last worker is still stopping waits and the tick is due again soon', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    await stub.addTask({ id: 'backAAAA', status: 'todo', machine: 'test-machine' });
    createRunFiles(dirs.run).writeId('backAAAA', 'pid', process.pid);
    writeFileSync(
      path.join(dirs.run, 'backAAAA.lane'),
      JSON.stringify({ lane: 'general', borrowed: false, startedAt: new Date().toISOString() }),
    );
    const before = Date.now();
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(stub.tasks.get('backAAAA')?.status).toBe('todo');
    expect(cli.stdout()).toContain('SKIP backAAAA its last worker is still stopping');
    const due = Date.parse(readFileSync(path.join(dirs.run, 'dispatch.next'), 'utf8'));
    expect(due).toBeGreaterThan(before);
    expect(due).toBeLessThan(before + 60_000);
  });

  it('[cli-066] a run over the maximum hours is stopped and swept', async () => {
    const rigged = await rig({ env: PROCESS, config: 'machine: test-machine\nmaxRunHours: 1\n' });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    await stub.addTask({ id: 'longAAAA', status: 'running', machine: 'test-machine' });
    stub.patch('longAAAA', { runStartedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      createRunFiles(dirs.run).writeId('longAAAA', 'pid', sleeper.pid as number);
      expect(await cli.run('internal', 'dispatch')).toBe(0);
      await exited;
    } finally {
      sleeper.kill('SIGKILL');
    }
    expect(stub.tasks.get('longAAAA')?.status).toBe('needs-me');
    expect(cli.stdout()).toContain('over the limit of 1 hours');
  });

  it('[cli-070] PR states are refreshed through gh at most every 10 minutes', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'board-gh-'));
    const gh = path.join(bin, 'gh');
    writeFileSync(gh, '#!/bin/sh\n');
    chmodSync(gh, 0o755);
    const lookups: string[] = [];
    const rigged = await rig({
      env: { ...PROCESS, PATH: bin },
      exec: (file, args) => {
        if (file === 'gh') lookups.push(args[2] ?? '');
        return { code: 0, stdout: 'MERGED\n' };
      },
    });
    const { stub, cli } = rigged;
    const url = 'https://github.com/acme/widgets/pull/7';
    await stub.addTask({ id: 'prAAAAAA', status: 'backlog' });
    stub.patch('prAAAAAA', {
      prs: [{ id: 'pr1', pr: await stub.seal(bindings.pr('prAAAAAA'), url), state: null }],
    });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(lookups).toEqual([url]);
    expect(stub.tasks.get('prAAAAAA')?.prs[0]?.state).toBe('merged');
    expect(cli.stdout()).toContain('PRSTATE prAAAAAA merged');
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(lookups).toHaveLength(1);
  });

  it('[cli-070] the tick lists tasks without prompts and reads them only when a PR refresh is due', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'board-gh-'));
    const gh = path.join(bin, 'gh');
    writeFileSync(gh, '#!/bin/sh\n');
    chmodSync(gh, 0o755);
    const lookups: string[] = [];
    const { stub, cli } = await rig({
      env: { ...PROCESS, PATH: bin },
      exec: (file, args) => {
        if (file === 'gh') lookups.push(args[2] ?? '');
        return { code: 0, stdout: 'MERGED\n' };
      },
    });
    const url = 'https://github.com/acme/widgets/pull/9';
    await stub.addTask({ id: 'prBBBBBB', status: 'backlog', input: `Review ${url}` });

    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(lookups).toEqual([url]);
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    const lists = stub.bodies('list-tasks');
    expect(lists.filter((body) => body.withoutInput !== true)).toHaveLength(1);
    expect(lists.filter((body) => body.withoutInput === true)).toHaveLength(2);
  });

  it('[cli-070] without gh nothing is looked up and nothing is logged', async () => {
    const { stub, cli } = await rig({ env: { ...PROCESS, PATH: '/nonexistent' } });
    await stub.addTask({ id: 'prAAAAAA', status: 'backlog' });
    stub.patch('prAAAAAA', {
      prs: [
        {
          id: 'pr1',
          pr: await stub.seal(bindings.pr('prAAAAAA'), 'https://github.com/acme/widgets/pull/7'),
          state: null,
        },
      ],
    });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(cli.stdout()).not.toContain('PRSTATE');
    expect(stub.bodies('set-pr-states')).toHaveLength(0);
  });

  it('[cli-064] applies the pause, resume and run requests of the board to the feeds and acknowledges them', async () => {
    const rigged = await rig({
      env: PROCESS,
      config:
        'machine: test-machine\nfeeds:\n  nightly:\n    integration: mk:items\n    action: list\n    every: 10m\n    dir: /tmp\n',
    });
    const { stub, cli } = rigged;
    stub.setFeedRequests([`pause:${feedIdOf('nightly')}`, `run:${feedIdOf('nightly')}`]);
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    const state = readFeedState(contextOf(rigged).dirs, 'nightly');
    expect(state.paused).toBe(true);
    expect(state.runRequestedAt).toBeDefined();
    expect(stub.bodies('ack-feed-requests')).toHaveLength(1);
  });
});

describe('waits and watches in a tick', () => {
  it('[cli-064] wakes a waiting task whose time is up, and one with an event nobody received', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    await stub.addTask({ id: 'dueAAAAA', status: 'waiting', machine: 'test-machine' });
    stub.patch('dueAAAAA', { wakeAt: new Date(Date.now() - 1_000).toISOString() });
    await stub.addTask({ id: 'eventAAA', status: 'waiting', machine: 'test-machine' });
    stub.patch('eventAAA', { wakeAt: future(60) });
    await stub.addTask({ id: 'sleepAAA', status: 'waiting', machine: 'test-machine' });
    stub.patch('sleepAAA', { wakeAt: future(60) });
    new WatchStore(dirs.state).writeEvent({
      id: 'e1',
      task: 'eventAAA',
      name: 'ci',
      at: new Date().toISOString(),
      kind: 'event',
      text: 'CI passed',
    });
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect((await noteTexts(stub, 'dueAAAAA'))[0]).toContain('its time ran out');
    expect((await noteTexts(stub, 'eventAAA'))[0]).toContain('CI passed');
    expect(new WatchStore(dirs.state).events('eventAAA')).toHaveLength(0);
    expect(stub.tasks.get('sleepAAA')?.status).toBe('waiting');
  });

  it('[cli-064] drops the watches of a finished task and applies the stops of the user', async () => {
    const rigged = await rig({ env: PROCESS });
    const { stub, cli } = rigged;
    const { dirs } = contextOf(rigged);
    const store = new WatchStore(dirs.state);
    const def = (task: string, name: string, id: string): WatchDef => ({
      id,
      name,
      task,
      createdAt: new Date().toISOString(),
      deadline: future(60),
      everyMs: 60_000,
      source: { kind: 'command', command: 'true', cwd: '/tmp' },
    });
    await stub.addTask({ id: 'doneAAAA', status: 'done' });
    await stub.addTask({ id: 'stopAAAA', status: 'waiting', machine: 'test-machine' });
    stub.patch('stopAAAA', { wakeAt: future(60), watchStops: ['0123456789abcdef'] });
    store.write(def('doneAAAA', 'build', 'aaaaaaaaaaaaaaaa'));
    store.write(def('stopAAAA', 'build', '0123456789abcdef'));
    store.write(def('stopAAAA', 'other', 'bbbbbbbbbbbbbbbb'));
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(store.list('doneAAAA').defs).toHaveLength(0);
    expect(store.list('stopAAAA').defs.map((entry) => entry.name)).toEqual(['other']);
    expect(stub.bodies('ack-watch-stops')).toHaveLength(1);
  });
});

describe('the watch runner', () => {
  async function runner(rigged: Rig) {
    const ctx = contextOf(rigged);
    const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    const store = new WatchStore(ctx.dirs.state);
    const lines: string[] = [];
    const calls: string[] = [];
    const deps = (code: number, stdout = ''): ScanDeps => ({
      s,
      store,
      dryRun: false,
      now: () => new Date(),
      log: (line) => lines.push(line),
      exec: (file, args) => {
        calls.push(`${file} ${args.join(' ')}`);
        return Promise.resolve({ code, stdout });
      },
      isAlive: () => false,
    });
    return { ctx, s, store, lines, calls, deps };
  }

  const command = (task: string, overrides: Partial<WatchDef> = {}): WatchDef => ({
    id: '0123456789abcdef',
    name: 'check',
    task,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    deadline: future(30),
    everyMs: 15_000,
    source: { kind: 'command', command: 'make ready', cwd: '/tmp' },
    ...overrides,
  });

  it('[cli-064] a command watch that passes wakes its waiting task with the output, and goes away', async () => {
    const rigged = await rig({ env: PROCESS });
    const { store, deps, calls } = await runner(rigged);
    await rigged.stub.addTask({ id: 'taskAAAA', status: 'waiting', machine: 'test-machine' });
    store.write(command('taskAAAA'));
    await scanWatches(deps(0, 'all ready\n'), { timeLeftMs: 5_000 });
    expect(calls).toEqual(['sh -c make ready']);
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect((await noteTexts(rigged.stub, 'taskAAAA'))[0]).toContain('all ready');
    expect(store.list('taskAAAA').defs).toHaveLength(0);
    expect(store.events('taskAAAA')).toHaveLength(0);
  });

  it('[cli-064] a command that fails is kept with its last result, and one that is not due is not run', async () => {
    const rigged = await rig({ env: PROCESS });
    const { store, deps, calls } = await runner(rigged);
    await rigged.stub.addTask({ id: 'taskAAAA', status: 'waiting', machine: 'test-machine' });
    store.write(command('taskAAAA'));
    await scanWatches(deps(1), { timeLeftMs: 5_000 });
    expect(store.read('taskAAAA', 'check')?.last?.summary).toBe('exit 1');
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('waiting');
    await scanWatches(deps(1), { timeLeftMs: 5_000 });
    expect(calls).toHaveLength(1);
  });

  it('[cli-064] a watch past its deadline ends as a timeout, and a timer as an event', async () => {
    const rigged = await rig({ env: PROCESS });
    const { store, deps } = await runner(rigged);
    await rigged.stub.addTask({ id: 'taskAAAA', status: 'waiting', machine: 'test-machine' });
    await rigged.stub.addTask({ id: 'taskBBBB', status: 'waiting', machine: 'test-machine' });
    const past = new Date(Date.now() - 1_000).toISOString();
    store.write(command('taskAAAA', { deadline: past }));
    store.write(
      command('taskBBBB', { name: 'timer', deadline: past, source: { kind: 'timer' }, everyMs: 0 }),
    );
    await scanWatches(deps(0), { timeLeftMs: 5_000 });
    expect((await noteTexts(rigged.stub, 'taskAAAA'))[0]).toContain('timed out');
    expect((await noteTexts(rigged.stub, 'taskBBBB'))[0]).toContain('the timer ended');
  });

  it('[cli-064] an event for a task that is not waiting is left as a note, and a running task keeps it for its worker', async () => {
    const rigged = await rig({ env: PROCESS });
    const { store, deps } = await runner(rigged);
    await rigged.stub.addTask({ id: 'needsAAA', status: 'needs-me' });
    await rigged.stub.addTask({ id: 'runAAAAA', status: 'running', machine: 'test-machine' });
    store.write(command('needsAAA'));
    store.write(command('runAAAAA'));
    await scanWatches(deps(0, 'ready'), { timeLeftMs: 5_000 });
    expect((await noteTexts(rigged.stub, 'needsAAA'))[0]).toContain('ready');
    expect(store.events('needsAAA')).toHaveLength(0);
    expect(rigged.stub.notes.get('runAAAAA') ?? []).toHaveLength(0);
    expect(store.events('runAAAAA')).toHaveLength(1);
  });

  it('[cli-064] a stream watch reports its lines, stops past the budget and reports the end of its command', async () => {
    const rigged = await rig({ env: PROCESS });
    const { store, deps, ctx } = await runner(rigged);
    await rigged.stub.addTask({ id: 'taskAAAA', status: 'needs-me' });
    store.write(
      command('taskAAAA', {
        name: 'tail',
        everyMs: 0,
        source: { kind: 'stream', command: 'tail -f log', cwd: '/tmp', starts: 0, events: 0 },
      }),
    );
    let ended: { code: number | null } | null = null;
    let pending = 'first line\n';
    const killed: string[] = [];
    const stop = new AbortController();
    const unit = runWatchUnit(
      {
        ...deps(0),
        stateDir: ctx.dirs.state,
        startStream: () => ({
          drain: () => {
            const text = pending;
            pending = '';
            return text;
          },
          get ended() {
            return ended;
          },
          kill: () => killed.push('killed'),
        }),
      },
      stop.signal,
      { scanMs: 20 },
    );
    await until(
      async () =>
        (await noteTexts(rigged.stub, 'taskAAAA')).some((text) => text.includes('first line')),
      'the first stream event',
    );
    expect(store.read('taskAAAA', 'tail')?.source).toMatchObject({ kind: 'stream', starts: 1 });
    ended = { code: 3 };
    await until(
      async () =>
        (await noteTexts(rigged.stub, 'taskAAAA')).some((text) => text.includes('exit code 3')),
      'the end of the command',
    );
    stop.abort();
    await unit;
    expect(store.list('taskAAAA').defs).toHaveLength(0);
  });
});

describe('the listener', () => {
  function listener(rigged: Rig, ticks: { count: number }, extra = {}) {
    const stop = new AbortController();
    const done = runListener(
      contextOf(rigged),
      {
        runTick: () => {
          ticks.count += 1;
          return Promise.resolve(0);
        },
        debounceMs: 40,
        backoffBaseMs: 20,
        retryMs: 30,
        feedScanMs: 60_000,
        ...extra,
      },
      stop.signal,
    );
    done.catch(() => undefined);
    return { stop, done };
  }

  it('[cli-065] ticks when it connects and once for the events of a debounce window', async () => {
    const rigged = await rig({ env: PROCESS });
    const ticks = { count: 0 };
    const { stop, done } = listener(rigged, ticks);
    await until(() => rigged.stub.streamCount() === 1 && ticks.count === 1, 'the first tick');
    rigged.stub.emitTasks();
    rigged.stub.emitTasks();
    rigged.stub.emitTasks();
    await until(() => ticks.count === 2, 'the debounced tick');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ticks.count).toBe(2);
    stop.abort();
    await done;
    expect(rigged.cli.stdout()).toContain('stopped');
  });

  it('[cli-065] reconnects after the stream ends, backing off, and ticks again', async () => {
    const rigged = await rig({ env: PROCESS });
    const ticks = { count: 0 };
    const { stop, done } = listener(rigged, ticks);
    await until(() => rigged.stub.streamCount() === 1, 'the stream');
    rigged.stub.endStreams();
    await until(() => ticks.count === 2 && rigged.stub.streamCount() === 1, 'the reconnect');
    stop.abort();
    await done;
  });

  it('[cli-065] exits 1 once the server no longer serves its token', async () => {
    const rigged = await rig({ env: PROCESS });
    const { done } = listener(rigged, { count: 0 });
    await until(() => rigged.stub.streamCount() === 1, 'the stream');
    rigged.stub.refuseToken();
    await expect(done).rejects.toMatchObject({ exitCode: 1 });
  });

  it('[cli-065] runs a tick again at the time the last tick said something is due', async () => {
    const rigged = await rig({ env: PROCESS });
    const ticks = { count: 0 };
    const { dirs } = contextOf(rigged);
    mkdirSync(dirs.run, { recursive: true });
    const { stop, done } = listener(rigged, ticks, {
      dueFloorMs: 10,
      runTick: () => {
        ticks.count += 1;
        if (ticks.count === 1) {
          writeFileSync(
            path.join(dirs.run, 'dispatch.next'),
            new Date(Date.now() + 60).toISOString(),
          );
        }
        return Promise.resolve(0);
      },
    });
    await until(() => ticks.count === 2, 'the timed tick');
    stop.abort();
    await done;
  });

  it('[cli-085] sends the directory list and applies the rumo agents when it starts', async () => {
    const rigged = await rig({
      env: PROCESS,
      config:
        'machine: test-machine\ndirs:\n  - id: 11111111-1111-4111-8111-111111111111\n    path: /tmp/work\n',
    });
    rigged.stub.setBoardAgents(
      1,
      await rigged.stub.seal(bindings.sharedAgents(1), JSON.stringify({ agents: {} })),
    );
    const { stop, done } = listener(rigged, { count: 0 });
    await until(() => rigged.stub.streamCount() === 1, 'the stream');
    expect(rigged.stub.commands()).toEqual(expect.arrayContaining(['set-dirs', 'get-agents']));
    stop.abort();
    await done;
  });
});

describe('the worker seam', () => {
  const FAKE_CLAUDE = `
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_LOG;
const note = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const task = process.env.RUMO_TASK;
let first = true;
rl.on('line', (line) => {
  const text = JSON.parse(line).message.content[0].text;
  if (first) {
    first = false;
    note({
      kind: 'prompt', text, task, cwd: process.cwd(), start: process.env.RUMO_START_DIR,
      pid: fs.readFileSync(process.env.FAKE_RUN + '/' + task + '.pid', 'utf8'),
      pgid: fs.readFileSync(process.env.FAKE_RUN + '/' + task + '.pgid', 'utf8'),
      argv: process.argv.slice(2), self: process.pid,
    });
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' }));
    if (text.includes('#fail')) process.exit(3);
    if (text.includes('#hold')) return;
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'sweepmarker' }] } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    return;
  }
  note({ kind: 'later', text });
  if (text.includes('shutting down')) process.exit(0);
});
rl.on('close', () => process.exit(0));
`;

  async function worker(prompt: string, config = '') {
    const home = tmpDir();
    const log = path.join(home, 'claude.log');
    const script = path.join(home, 'claude.cjs');
    writeFileSync(script, FAKE_CLAUDE);
    const rigged = await rig({
      env: { ...PROCESS, FAKE_LOG: log },
      config: `machine: test-machine\ndefaultCwd: ${home}\n${config}`,
    });
    const ctx = contextOf(rigged);
    const rt = {
      ...rigged.cli.test.rt,
      env: { ...rigged.cli.test.rt.env, FAKE_RUN: ctx.dirs.run },
    };
    const context = { ...ctx, rt };
    await rigged.stub.addTask({
      id: 'taskAAAA',
      status: 'running',
      machine: 'test-machine',
      input: prompt,
    });
    rigged.stub.patch('taskAAAA', { autoDone: true });
    const startClaude = (
      args: readonly string[],
      options: { cwd: string; env: Record<string, string | undefined> },
    ) =>
      spawn(process.execPath, [script, ...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    const entries = (): Record<string, unknown>[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
    return { rigged, context, home, startClaude, entries };
  }

  it('[cli-071] runs claude with the prompt on stdin as stream-json, writes its pid and group, and finishes the task', async () => {
    const { rigged, context, home, startClaude, entries } = await worker('write the report');
    const code = await runWorker(context, 'taskAAAA', { startClaude });
    expect(code).toBe(0);
    const [prompt] = entries();
    expect(prompt).toMatchObject({ kind: 'prompt', text: 'write the report', task: 'taskAAAA' });
    expect(prompt?.argv).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
      ]),
    );
    expect(JSON.stringify(prompt?.argv)).not.toContain('write the report');
    expect(prompt?.pid).toBe(String(process.pid));
    expect(prompt?.pgid).toBe(String(prompt?.self));
    expect(realpath(String(prompt?.cwd))).toBe(realpath(home));
    expect(prompt?.start).toBe(home);
    expect(rigged.stub.tasks.get('taskAAAA')).toMatchObject({
      status: 'done',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(existsSync(path.join(context.dirs.run, 'taskAAAA.pid'))).toBe(false);
    expect(readFileSync(path.join(context.dirs.state, 'logs', 'taskAAAA.log'), 'utf8')).toContain(
      'sweepmarker',
    );
  });

  it('[cli-071] a task that does not finish by itself goes to needs-me', async () => {
    const { rigged, context, startClaude } = await worker('write the report');
    rigged.stub.patch('taskAAAA', { autoDone: false });
    expect(await runWorker(context, 'taskAAAA', { startClaude })).toBe(0);
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('needs-me');
  });

  it('[cli-071] claude ending without a result fails the task with the end of the log', async () => {
    const { rigged, context, startClaude } = await worker('#fail now');
    expect(await runWorker(context, 'taskAAAA', { startClaude })).toBe(1);
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('needs-me');
    const [text] = await noteTexts(rigged.stub, 'taskAAAA');
    expect(text).toContain('claude ended without a result (exit 3)');
    expect(text).toContain('End of the log:');
  });

  it('[cli-071] a task with no directory to run in is failed instead of started', async () => {
    const rigged = await rig({ env: PROCESS });
    const ctx = contextOf(rigged);
    await rigged.stub.addTask({ id: 'taskAAAA', status: 'running', machine: 'test-machine' });
    expect(await runWorker(ctx, 'taskAAAA')).toBe(1);
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('needs-me');
    expect((await noteTexts(rigged.stub, 'taskAAAA'))[0]).toContain('no directory to run in');
  });

  it('[cli-055] the shutdown signal tells the agent to pause, then pauses the task and clears the run files', async () => {
    const { rigged, context, startClaude, entries } = await worker('#hold forever');
    const signals = new EventEmitter();
    const done = runWorker(context, 'taskAAAA', {
      startClaude,
      signals: signals as NodeJS.Process,
    });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    const files = createRunFiles(context.dirs.run);
    expect(files.pidOf('taskAAAA', 'pid')?.id).toBe(process.pid);
    files.requestShutdown('taskAAAA', new Date(Date.now() + 5_000));
    signals.emit('SIGUSR2');
    expect(await done).toBe(0);
    expect(entries().find((entry) => entry.kind === 'later')?.text).toMatch(/shutting down/);
    expect(rigged.stub.tasks.get('taskAAAA')?.status).toBe('todo');
    expect(files.tasksWith('pid')).toEqual([]);
  });

  it('[cli-055] a started worker passes the liveness check of the dispatcher and a stopped one does not', async () => {
    const rigged = await rig({ env: PROCESS });
    const { dirs } = contextOf(rigged);
    const files = createRunFiles(dirs.run);
    files.writeId('taskAAAA', 'pid', process.pid);
    const stale = createRunFiles(dirs.run);
    stale.writeId('taskBBBB', 'pid', 2_147_483_646);
    const { liveWorkerPid } = await import('../src/shutdown/index.js');
    const deps = { files, processes: systemProcessOps };
    expect(liveWorkerPid(deps, 'taskAAAA')).toBe(process.pid);
    expect(liveWorkerPid(deps, 'taskBBBB')).toBeNull();
  });
});

describe('dispatch configuration', () => {
  it('[cli-067] reads lanes, limits and the default lane from config.yaml', async () => {
    const rigged = await rig({
      config:
        'machine: m\nlanes:\n  a:\n    slots: 2\n  b:\n    slots: 1\n    default: true\npauseAfterMinutes: 9\nusageLimits:\n  sevenDay: 70\n',
    });
    const config = loadDispatchConfig(contextOf(rigged).dirs.config);
    expect(config.lanes.map((entry) => [entry.name, entry.slots, entry.default])).toEqual([
      ['a', 2, false],
      ['b', 1, true],
    ]);
    expect(config.pauseAfterMinutes).toBe(9);
    expect(config.usageLimits).toEqual({ sevenDay: 70, priority: 'urgent' });
  });
});

function realpath(target: string): string {
  return path.resolve(target).replace(/^\/private/, '');
}
