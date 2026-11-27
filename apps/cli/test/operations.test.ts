import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { workerUnits } from '@rumo/contract';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/commands/context.js';
import { runCli } from '../src/commands/program.js';
import { completeIds } from '../src/completion/index.js';
import { EXIT } from '../src/errors.js';
import {
  createRunFiles,
  parseElapsed,
  shutdownWorkers,
  systemProcessOps,
  type ProcessOps,
} from '../src/shutdown/index.js';
import { useRig } from './support/harness.js';
import { testRuntime } from './support/runtime.js';

const rig = useRig();

function fakeProcesses(
  alive: Set<number>,
  onSignal?: (pid: number, signal: string) => void,
  startedAt = 0,
) {
  const signals: string[] = [];
  const ops: ProcessOps = {
    startedAt: (pid) => (alive.has(pid) ? startedAt : null),
    signal: (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      onSignal?.(pid, signal);
    },
  };
  return { ops, signals };
}

function clockOf() {
  let at = 1_000_000;
  return {
    now: () => at,
    sleep: (ms: number): Promise<void> => {
      at += ms;
      return Promise.resolve();
    },
  };
}

describe('rumo internal units', () => {
  it('[cli-054] prints the recipe as JSON, valid against the contract, for the profile', async () => {
    const test = testRuntime({ platform: 'linux', self: ['/opt/board/bin/rumo'] });
    expect(await runCli(['--profile', 'work', 'internal', 'units'], test.rt)).toBe(0);
    const recipe = workerUnits.parse(JSON.parse(test.captured.stdout));
    expect(recipe.platform).toBe('linux');
    expect(recipe.units.map((unit) => unit.name)).toEqual(['dispatch', 'listen', 'watch']);
    for (const unit of recipe.units) {
      expect(unit.program).toBe('/opt/board/bin/rumo');
      expect(unit.args).toEqual(['--profile', 'work', 'internal', unit.name]);
    }
    test.dispose();
  });

  it('[cli-054] prints the macOS recipe on macOS and names only passed variables that are set', async () => {
    const test = testRuntime({
      platform: 'darwin',
      env: { RUMO_CREDENTIALS_COMMAND: '/opt/creds' },
    });
    expect(await runCli(['internal', 'units'], test.rt)).toBe(0);
    const recipe = workerUnits.parse(JSON.parse(test.captured.stdout));
    expect(recipe.platform).toBe('darwin');
    expect(recipe.passedVariables).toContain('RUMO_CREDENTIALS_COMMAND');
    test.dispose();
  });

  it('[cli-054] refuses on a platform without units and inside a run', async () => {
    const windows = testRuntime({ platform: 'win32' });
    expect(await runCli(['internal', 'units'], windows.rt)).toBe(EXIT.failure);
    expect(windows.captured.stderr).toMatch(/Linux or macOS/);
    const inRun = testRuntime({ env: { RUMO_TASK: 'abc12345' } });
    expect(await runCli(['internal', 'units'], inRun.rt)).toBe(EXIT.failure);
    windows.dispose();
    inRun.dispose();
  });

  it('[cli-054] board internal alone is a usage error that lists the subcommands', async () => {
    const test = testRuntime();
    expect(await runCli(['internal'], test.rt)).toBe(EXIT.usage);
    expect(test.captured.stderr).toMatch(/units, shutdown/);
    test.dispose();
  });
});

describe('rumo internal shutdown', () => {
  it('[cli-055] asks each running worker to pause and reports it paused when it ends', async () => {
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taskaaaa.pid'), '4001');
    writeFileSync(path.join(dir, 'taskaaaa.pgid'), '4002');
    const alive = new Set([4001]);
    const { ops, signals } = fakeProcesses(alive, (pid, signal) => {
      if (pid === 4001 && signal === 'SIGUSR2') alive.delete(4001);
    });
    const clock = clockOf();
    const lines: string[] = [];
    const results = await shutdownWorkers({
      files: createRunFiles(dir),
      processes: ops,
      graceMs: 20_000,
      ...clock,
      print: (line) => lines.push(line),
    });
    expect(results.get('taskaaaa')).toBe('paused');
    expect(lines[0]).toMatch(/pausing 1 running worker/);
    expect(lines).toContain('taskaaaa paused');
    expect(signals).toContain('4001:SIGUSR2');
    expect(signals).toContain('-4002:SIGKILL');
    expect(existsSync(path.join(dir, 'taskaaaa.pid'))).toBe(false);
    test.dispose();
  });

  it('[cli-055] writes the deadline the worker must end its run by, before the grace ends', async () => {
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taskbbbb.pid'), '4010');
    const alive = new Set([4010]);
    const seen: string[] = [];
    const { ops } = fakeProcesses(alive, (_pid, signal) => {
      if (signal === 'SIGUSR2')
        seen.push(readFileSync(path.join(dir, 'taskbbbb.shutdown'), 'utf8'));
      alive.clear();
    });
    const clock = clockOf();
    await shutdownWorkers({
      files: createRunFiles(dir),
      processes: ops,
      graceMs: 20_000,
      ...clock,
      print: () => undefined,
    });
    expect(Date.parse(seen[0] ?? '')).toBe(1_000_000 + 20_000 - 5_000);
    test.dispose();
  });

  it('[cli-055] stops a worker that is still alive when the grace ends, with its agents', async () => {
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taskcccc.pid'), '4020');
    writeFileSync(path.join(dir, 'taskcccc.pgid'), '4021');
    const { ops, signals } = fakeProcesses(new Set([4020]));
    const lines: string[] = [];
    const results = await shutdownWorkers({
      files: createRunFiles(dir),
      processes: ops,
      graceMs: 2_000,
      ...clockOf(),
      print: (line) => lines.push(line),
    });
    expect(results.get('taskcccc')).toBe('stopped');
    expect(lines).toContain('taskcccc stopped');
    expect(signals).toEqual(expect.arrayContaining(['-4021:SIGKILL', '4020:SIGKILL']));
    test.dispose();
  });

  it('[cli-055] kills the agents of a worker that is gone, as idle agents', async () => {
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taskdddd.pgid'), '4030');
    writeFileSync(path.join(dir, 'taskdddd.pid'), '4031');
    const { ops, signals } = fakeProcesses(new Set());
    const results = await shutdownWorkers({
      files: createRunFiles(dir),
      processes: ops,
      graceMs: 2_000,
      ...clockOf(),
      print: () => undefined,
    });
    expect(results.get('taskdddd')).toBe('stopped');
    expect(signals).toEqual(['-4030:SIGKILL']);
    test.dispose();
  });

  it('[cli-055] signals no process that started after its run file was written', async () => {
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'taskffff.pid'), '4040');
    writeFileSync(path.join(dir, 'taskffff.pgid'), '4041');
    writeFileSync(path.join(dir, 'taskgggg.pgid'), '1');
    const { ops, signals } = fakeProcesses(new Set([4040, 4041]), undefined, Date.now() + 60_000);
    const lines: string[] = [];
    await shutdownWorkers({
      files: createRunFiles(dir),
      processes: ops,
      graceMs: 2_000,
      ...clockOf(),
      print: (line) => lines.push(line),
    });
    expect(signals).toEqual([]);
    expect(lines).not.toContain('taskffff paused');
    expect(existsSync(path.join(dir, 'taskffff.pid'))).toBe(false);
    test.dispose();
  });

  it('[cli-055] reads the start of a process from ps', () => {
    expect(parseElapsed('   05:07\n')).toBe(307);
    expect(parseElapsed('02:05:07')).toBe(7507);
    expect(parseElapsed('1-02:05:07')).toBe(93907);
    expect(parseElapsed('')).toBeNull();
    const started = systemProcessOps.startedAt(process.pid);
    expect(started).not.toBeNull();
    expect(started).toBeLessThanOrEqual(Date.now());
  });

  it('[cli-055] reports that no worker runs, and exits 0', async () => {
    const test = testRuntime();
    expect(await runCli(['internal', 'shutdown', '--grace', '3'], test.rt)).toBe(0);
    expect(test.captured.stdout).toMatch(/no worker is running/);
    test.dispose();
  });

  it('[cli-055] --grace takes seconds above 0', async () => {
    const test = testRuntime();
    expect(await runCli(['internal', 'shutdown', '--grace', '0'], test.rt)).toBe(EXIT.usage);
    expect(await runCli(['internal', 'shutdown', '--grace', 'soon'], test.rt)).toBe(EXIT.usage);
    test.dispose();
  });

  it('[cli-055] pauses a real worker process that handles the pause signal', async () => {
    const { spawn } = await import('node:child_process');
    const test = testRuntime();
    const dir = test.path('run');
    mkdirSync(dir, { recursive: true });
    const worker = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGUSR2', () => process.exit(0)); setInterval(() => {}, 1000); console.log('up');",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve) => worker.stdout.once('data', () => resolve()));
    writeFileSync(path.join(dir, 'taskeeee.pid'), String(worker.pid));
    const exited = new Promise<number | null>((resolve) =>
      worker.once('exit', (code) => resolve(code)),
    );
    expect(await runCli(['internal', 'shutdown', '--grace', '5'], test.rt)).toBe(0);
    expect(test.captured.stdout).toMatch(/taskeeee paused/);
    expect(await exited).toBe(0);
    test.dispose();
  });
});

describe('shell completion', () => {
  it.each([
    ['bash', 'complete -F _rumo rumo'],
    ['zsh', 'compdef _rumo rumo'],
    ['fish', "complete -c board -n '__fish_use_subcommand'"],
  ])('[cli-061] %s script completes commands, task ids and schedule ids', async (shell, marker) => {
    const test = testRuntime();
    expect(await runCli(['completion', shell], test.rt)).toBe(0);
    const script = test.captured.stdout;
    expect(script).toContain(marker);
    expect(script).toContain('__complete tasks');
    expect(script).toContain('__complete schedules');
    for (const command of ['tasks', 'show', 'self-update', 'completion', 'schedules']) {
      expect(script).toContain(command);
    }
    expect(script).not.toMatch(/\binternal\b/);
    expect(script).not.toContain('__complete  ');
    test.dispose();
  });

  it('[cli-061] the scripts offer task ids after the commands that take one', async () => {
    const test = testRuntime();
    await runCli(['completion', 'bash'], test.rt);
    const caseLine = /^ {4}(\S+)\)$/m.exec(test.captured.stdout)?.[1] ?? '';
    for (const command of ['show', 'attach', 'comment', 'move', 'stop', 'fork']) {
      expect(caseLine.split('|')).toContain(command);
    }
    test.dispose();
  });

  it('[cli-061] an unknown shell is a usage error', async () => {
    const test = testRuntime();
    expect(await runCli(['completion', 'powershell'], test.rt)).toBe(EXIT.usage);
    test.dispose();
  });

  it('[cli-061] __complete prints task ids and schedule ids, one per line', async () => {
    const { stub, cli } = await rig();
    await stub.addTask({ id: 'taskaaaa' });
    await stub.addTask({ id: 'taskbbbb', status: 'done' });
    expect(await cli.run('__complete', 'tasks')).toBe(0);
    expect(cli.stdout().split('\n').filter(Boolean).sort()).toEqual(['taskaaaa', 'taskbbbb']);
    cli.reset();
    expect(await cli.run('__complete', 'schedules')).toBe(0);
    expect(cli.stdout()).toBe('');
  });

  it('[cli-061] a server that never answers yields no ids once the budget is spent', async () => {
    const { cli } = await rig({ fetch: () => new Promise<Response>(() => undefined) });
    const ctx = buildContext(cli.test.rt, {});
    const started = Date.now();
    expect(await completeIds(ctx, 'tasks', 100)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('[cli-061] __complete answers within 2 s and exits 0 when the server is slow or down', async () => {
    const { stub, cli } = await rig();
    stub.forbid('list-tasks');
    const started = Date.now();
    expect(await cli.run('__complete', 'tasks')).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cli.stdout()).toBe('');
    await stub.stop();
    expect(await cli.run('__complete', 'tasks')).toBe(0);
    expect(await cli.run('__complete')).toBe(0);
    expect(await cli.run('__complete', 'nonsense')).toBe(0);
    expect(cli.stdout()).toBe('');
  });
});

describe('board example', () => {
  it('[cli-012] lists the examples and prints one', async () => {
    const test = testRuntime();
    expect(await runCli(['example'], test.rt)).toBe(0);
    const [first] = test.captured.stdout.split('\n');
    expect(first).toBeTruthy();
    test.captured.stdout = '';
    expect(await runCli(['example', first ?? ''], test.rt)).toBe(0);
    expect(test.captured.stdout.length).toBeGreaterThan(10);
    expect(await runCli(['example', 'nope'], test.rt)).toBe(EXIT.usage);
    test.dispose();
  });
});
