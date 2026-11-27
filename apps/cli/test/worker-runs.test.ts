import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { MAX_ACK_MESSAGES } from '@rumo/contract';
import { bindings, open as openEnvelope } from '@rumo/sealing';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/commands/context.js';
import { createRunRecords } from '../src/dispatch/run-record.js';
import { createSessionStore } from '../src/worker/sessions.js';
import { boardFirst, runWorker, type WorkerDeps } from '../src/worker/run.js';
import { WatchStore } from '../src/watch/store.js';
import { readStoredUsage } from '../src/dispatch/usage.js';
import type { ApiStub } from './support/api-stub.js';
import { useRig } from './support/harness.js';
import { tmpDir } from './support/files.js';

const rig = useRig();
const PROCESS = { RUMO_WORKER_SPAWN: 'process' } as const;
const TASK = 'taskAAAA';
const SESSION = '33333333-3333-4333-8333-333333333333';

const FAKE_CLAUDE = `
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_LOG;
const note = (entry) => fs.appendFileSync(log, JSON.stringify(entry) + '\\n');
const out = (event) => console.log(JSON.stringify(event));
process.on('SIGINT', () => {
  note({ kind: 'signal', signal: 'SIGINT' });
  if (process.env.FAKE_IGNORE_INTERRUPT !== '1') process.exit(130);
});
const rl = readline.createInterface({ input: process.stdin });
let first = true;
let keep = false;
rl.on('line', (line) => {
  const text = JSON.parse(line).message.content[0].text;
  if (!first) {
    note({ kind: 'later', text });
    if (/Pause|pause/.test(text) && !keep) {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'paused' });
    }
    return;
  }
  first = false;
  keep = text.includes('#keep');
  note({ kind: 'prompt', text, argv: process.argv.slice(2), env: process.env.RUMO_RESTRICTED || '', path: process.env.PATH });
  out({ type: 'system', subtype: 'init', session_id: process.argv.includes('--resume') && !process.argv.includes('--fork-session') ? process.argv[process.argv.indexOf('--resume') + 1] : process.argv[process.argv.indexOf('--session-id') + 1], model: 'fake-model' });
  if (text.includes('#usage')) {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'main' }], usage: { input_tokens: 50000, output_tokens: 3 } } });
    out({ type: 'assistant', parent_tool_use_id: 'toolu_sub', message: { content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 4321 } } });
    out({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.37, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  }
  if (text.includes('#tool')) {
    out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 0 } } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'listing' }] } });
  }
  if (text.includes('#hold')) return;
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
});
rl.on('close', () => {
  note({ kind: 'stdin-closed' });
  if (process.env.FAKE_IGNORE_INTERRUPT === '1') { setInterval(() => undefined, 1 << 30); return; }
  process.exit(0);
});
`;

interface Entry {
  readonly kind: string;
  readonly [key: string]: unknown;
}

async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function plain(stub: ApiStub, body: string, author = 'system', kind = 'event') {
  return stub.open(
    bindings.note({ field: 'note.body', taskId: TASK, author: author as 'system', kind }),
    body,
  );
}

async function setup(
  prompt: string,
  options: { config?: string; env?: Record<string, string>; agent?: string; forkOf?: string } = {},
) {
  const home = tmpDir();
  const log = path.join(home, 'claude.log');
  const script = path.join(home, 'claude.cjs');
  writeFileSync(script, FAKE_CLAUDE);
  const rigged = await rig({
    env: { ...PROCESS, FAKE_LOG: log, ...options.env },
    config: `machine: test-machine\ndefaultCwd: ${home}\n${options.config ?? ''}`,
  });
  const base = buildContext(rigged.cli.test.rt, {});
  const context = { ...base, rt: { ...base.rt, env: { ...base.rt.env, FAKE_RUN: base.dirs.run } } };
  await rigged.stub.addTask({
    id: TASK,
    status: 'running',
    machine: 'test-machine',
    input: prompt,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.forkOf === undefined ? {} : { forkOf: options.forkOf }),
  });
  rigged.stub.patch(TASK, { run: 'runAAAAAAAAAAAAAA', autoDone: true });
  const startClaude: NonNullable<WorkerDeps['startClaude']> = (args, startOptions) =>
    spawn(process.execPath, [script, ...args], {
      cwd: startOptions.cwd,
      env: startOptions.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const entries = (): Entry[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Entry)
      : [];
  const args = (): string[] =>
    (entries().find((entry) => entry.kind === 'prompt')?.argv as string[]) ?? [];
  const fast: WorkerDeps = {
    startClaude,
    tickMs: 20,
    heartbeatMs: 10_000,
    uploadMs: 30,
    stopKillMs: 150,
  };
  return { rigged, stub: rigged.stub, context, home, entries, args, fast };
}

describe('the inbox of a run', () => {
  it('[cli-075] hands the agent a message the user sent and acknowledges it once', async () => {
    const { stub, context, entries, fast } = await setup('#hold wait');
    const done = runWorker(context, TASK, fast);
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    await stub.sendToRun(TASK, 'please also check the docs');
    await until(() => entries().some((entry) => entry.kind === 'later'), 'the message');
    const later = entries().find((entry) => entry.kind === 'later');
    expect(String(later?.text)).toContain('please also check the docs');
    await until(() => stub.bodies('ack-messages').length > 0, 'the acknowledgement');
    expect(stub.bodies('ack-messages')[0]).toMatchObject({ ids: ['n1'] });
    stub.requestStop(TASK);
    await done;
    expect(entries().filter((entry) => entry.kind === 'later')).toHaveLength(1);
  });

  it('[cli-075] acknowledges a full inbox in batches the contract accepts', async () => {
    const { stub, context, entries, fast } = await setup('#hold wait');
    const done = runWorker(context, TASK, fast);
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    for (let index = 0; index < MAX_ACK_MESSAGES + 20; index += 1) {
      await stub.sendToRun(TASK, `message ${index}`);
    }
    const acknowledged = (): string[] =>
      stub.bodies('ack-messages').flatMap((body) => body.ids as string[]);
    await until(
      () => new Set(acknowledged()).size === MAX_ACK_MESSAGES + 20,
      'every acknowledgement',
    );
    for (const body of stub.bodies('ack-messages')) {
      expect((body.ids as string[]).length).toBeLessThanOrEqual(MAX_ACK_MESSAGES);
    }
    stub.requestStop(TASK);
    await done;
  });

  it('[cli-074] a stop interrupts the agent, closes its stdin and kills it only after the grace', async () => {
    const { stub, context, entries, fast } = await setup('#hold forever', {
      env: { FAKE_IGNORE_INTERRUPT: '1' },
    });
    const done = runWorker(context, TASK, { ...fast, stopKillMs: 400 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    stub.requestStop(TASK);
    await until(() => entries().some((entry) => entry.kind === 'signal'), 'the interrupt');
    const startedAt = Date.now();
    await until(() => entries().some((entry) => entry.kind === 'stdin-closed'), 'stdin to close');
    expect(await done).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(stub.bodies('ack-messages').some((body) => body.stop === true)).toBe(true);
    expect(stub.commands()).toContain('stopped');
    expect(stub.tasks.get(TASK)?.status).toBe('needs-me');
    expect(await plain(stub, String(stub.bodies('stopped')[0]?.body))).toBe('Stopped by you.');
  });

  it('[cli-074] a stop interrupts the agent at once when it follows the interrupt', async () => {
    const { stub, context, entries, fast } = await setup('#hold forever');
    const done = runWorker(context, TASK, { ...fast, stopKillMs: 5_000 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    stub.requestStop(TASK);
    expect(await done).toBe(0);
    expect(stub.tasks.get(TASK)?.status).toBe('needs-me');
  });
});

describe('the liveness of a run', () => {
  it('[cli-066] passes on a heartbeat only while the agent shows signs of life', async () => {
    const { stub, context, entries, fast } = await setup('#hold quiet');
    const done = runWorker(context, TASK, { ...fast, heartbeatMs: 15 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const quiet = stub.bodies('heartbeat').length;
    expect(quiet).toBeGreaterThanOrEqual(1);
    expect(quiet).toBeLessThanOrEqual(3);
    stub.requestStop(TASK);
    await done;
  });
});

describe('a machine that sleeps', () => {
  it('[cli-073] a jump of the clock is not inactivity and does not tell the board the agent was active', async () => {
    const { stub, context, entries, fast } = await setup('#hold quiet', {
      config: 'inactivityMinutes: 1\n',
    });
    let offset = 0;
    const done = runWorker(context, TASK, {
      ...fast,
      heartbeatMs: 15,
      now: () => Date.now() + offset,
    });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = stub.bodies('heartbeat').length;
    offset = 90_000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.commands()).not.toContain('fail');
    expect(stub.bodies('heartbeat').length).toBe(before);
    stub.requestStop(TASK);
    expect(await done).toBe(0);
  });
});

describe('pausing a run', () => {
  it('[cli-075] a lane pause file tells the agent to pause with the lane wording and pauses the task without the shutdown wording', async () => {
    const { stub, context, entries, fast } = await setup('#hold wait', {
      config: 'lanes:\n  general:\n    slots: 1\n',
    });
    const done = runWorker(context, TASK, { ...fast, lanePauseGraceMs: 60_000 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    createRunRecords(context.dirs.run).requestPause(TASK, new Date());
    await until(() => entries().some((entry) => entry.kind === 'later'), 'the pause message');
    expect(String(entries().find((entry) => entry.kind === 'later')?.text)).toMatch(
      /lane needs the slot/,
    );
    expect(await done).toBe(0);
    expect(stub.tasks.get(TASK)).toMatchObject({ status: 'todo', paused: true });
    const reported = await plain(stub, String(stub.bodies('pause')[0]?.body));
    expect(reported).toContain('its general lane needed the slot');
    expect(reported).not.toMatch(/shut/);
  });

  it('[cli-075] an agent that ignores the lane pause is interrupted after the grace and the task still pauses', async () => {
    const { stub, context, entries, fast } = await setup('#hold #keep wait');
    const done = runWorker(context, TASK, { ...fast, lanePauseGraceMs: 100 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    createRunRecords(context.dirs.run).requestPause(TASK, new Date());
    expect(await done).toBe(0);
    expect(entries().map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(signal|stdin-closed)$/)]),
    );
    expect(stub.tasks.get(TASK)).toMatchObject({ status: 'todo', paused: true });
    expect(await plain(stub, String(stub.bodies('pause')[0]?.body))).toContain(
      'lane needed the slot',
    );
  });
});

describe('a task that leaves running while its agent lives', () => {
  it('[cli-075] closes the input of the agent once the board no longer has the task running and ends the worker quietly', async () => {
    const { stub, context, entries, fast } = await setup('#hold asked');
    const done = runWorker(context, TASK, { ...fast, leftRunningGraceMs: 5_000 });
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    stub.patch(TASK, { status: 'needs-me' });
    await until(() => entries().some((entry) => entry.kind === 'stdin-closed'), 'stdin to close');
    expect(await done).toBe(0);
    expect(stub.commands()).not.toContain('fail');
    expect(stub.tasks.get(TASK)?.status).toBe('needs-me');
  });
});

describe('the limits of a run inside the worker', () => {
  it('[cli-073] interrupts an agent that is idle past the inactivity limit and moves the task to needs-me', async () => {
    const { stub, context, fast } = await setup('#hold quiet', {
      config: 'inactivityMinutes: 0.002\n',
    });
    expect(await runWorker(context, TASK, fast)).toBe(1);
    expect(stub.tasks.get(TASK)?.status).toBe('needs-me');
    expect(await plain(stub, String(stub.bodies('fail')[0]?.body))).toMatch(
      /no tool call for 0.002 minutes/,
    );
  });

  it('[cli-073] interrupts a run that lasts past the maximum run hours', async () => {
    const { stub, context, fast } = await setup('#hold long', { config: 'maxRunHours: 0.00002\n' });
    expect(await runWorker(context, TASK, fast)).toBe(1);
    expect(await plain(stub, String(stub.bodies('fail')[0]?.body))).toMatch(
      /longest a run may take/,
    );
  });
});

describe('the transcript of a run', () => {
  it('[cli-077] uploads sealed events while the run goes and at its end, with the main agent context and no subagent usage', async () => {
    const { stub, context, fast } = await setup('#usage #tool go');
    expect(await runWorker(context, TASK, fast)).toBe(0);
    const [run] = stub.uploads(TASK);
    const kinds = run?.events.map((event) => event.kind) ?? [];
    expect(kinds).toEqual(
      expect.arrayContaining(['text', 'tool_use', 'tool_result', 'result', 'context']),
    );
    const context_ = run?.events.find((event) => event.kind === 'context');
    const data = await openEnvelope(
      stub.keys,
      bindings.transcript({
        field: 'tr.data',
        taskId: TASK,
        runId: run?.runId ?? '',
        seq: context_?.seq ?? 0,
      }),
      context_?.data ?? '',
    );
    expect(JSON.parse(data)).toMatchObject({ used: 50_000, model: 'fake-model' });
    expect(data).not.toContain('4321');
    const output = run?.events.find((event) => event.kind === 'tool_result');
    expect(
      await openEnvelope(
        stub.keys,
        bindings.transcript({
          field: 'tr.output',
          taskId: TASK,
          runId: run?.runId ?? '',
          seq: output?.seq ?? 0,
        }),
        output?.output ?? '',
      ),
    ).toBe('listing');
  });

  it('[cli-078] sends no transcript when the board has no transcripts feature', async () => {
    const home = tmpDir();
    const rigged = await rig({
      env: { ...PROCESS },
      board: { features: ['run-inbox'] },
      config: `machine: test-machine\ndefaultCwd: ${home}\n`,
    });
    const script = path.join(home, 'claude.cjs');
    writeFileSync(script, FAKE_CLAUDE);
    const log = path.join(home, 'claude.log');
    const context = buildContext(rigged.cli.test.rt, {});
    await rigged.stub.addTask({
      id: TASK,
      status: 'running',
      machine: 'test-machine',
      input: '#usage',
    });
    rigged.stub.patch(TASK, { run: 'runAAAAAAAAAAAAAA' });
    const rt = { ...context.rt, env: { ...context.rt.env, FAKE_LOG: log } };
    const startClaude: NonNullable<WorkerDeps['startClaude']> = (args, options) =>
      spawn(process.execPath, [script, ...args], {
        cwd: options.cwd,
        env: { ...options.env, FAKE_LOG: log },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    expect(
      await runWorker({ ...context, rt }, TASK, { startClaude, tickMs: 20, uploadMs: 20 }),
    ).toBe(0);
    expect(rigged.stub.commands()).not.toContain('transcript');
  });

  it('[cli-068] records the rate limit the agent reports where the tick reads it', async () => {
    const { context, fast } = await setup('#usage go');
    expect(await runWorker(context, TASK, fast)).toBe(0);
    expect(readStoredUsage(context.dirs.state).fiveHour?.utilization).toBe(0.37);
  });
});

describe('what the worker passes to the agent', () => {
  it('[cli-072] a user task runs in auto mode and an agent task in dontAsk mode with its lists, marked restricted', async () => {
    const user = await setup('plain');
    expect(await runWorker(user.context, TASK, user.fast)).toBe(0);
    expect(user.args()).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    expect(user.entries().find((entry) => entry.kind === 'prompt')?.env).toBe('');

    const restricted = await setup('plain', { agent: 'careful' });
    mkdirSync(restricted.context.dirs.config, { recursive: true });
    writeFileSync(
      path.join(restricted.context.dirs.config, 'config.yaml'),
      [
        'machine: test-machine',
        `defaultCwd: ${restricted.home}`,
        'agents:',
        '  careful:',
        '    description: careful agent',
        '    tools: [Bash, Read]',
        '    allowedTools: ["Bash(git status:*)"]',
        '    disallowedTools: ["Bash(rm:*)"]',
        '',
      ].join('\n'),
    );
    expect(await runWorker(restricted.context, TASK, restricted.fast)).toBe(0);
    const args = restricted.args();
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Bash(git status:*)');
    expect(restricted.entries().find((entry) => entry.kind === 'prompt')?.env).toBe('1');
    expect(existsSync(path.join(restricted.context.dirs.run, `${TASK}.agents`))).toBe(false);
  });

  it('[cli-072] a task that names an agent this machine does not define is failed instead of started', async () => {
    const { stub, context, fast, entries } = await setup('plain', { agent: 'ghost' });
    expect(await runWorker(context, TASK, fast)).toBe(1);
    expect(entries()).toHaveLength(0);
    expect(await plain(stub, String(stub.bodies('fail')[0]?.body))).toContain('agent ghost');
  });

  it('[cli-071] puts the CLI directory first on the path of the agent so its board is this one', async () => {
    expect(boardFirst(['/usr/bin/node', '/opt/rumo/rumo'], '/usr/bin')).toBe('/opt/rumo:/usr/bin');
    expect(boardFirst(['/usr/bin/node', '/opt/rumo/main.js'], '/usr/bin')).toBe('/usr/bin');
    expect(boardFirst(['rumo'], undefined)).toBe('');
  });
});

describe('resuming and forking', () => {
  it('[cli-076] resumes a session this machine recorded, with what the user wrote since', async () => {
    const { stub, context, fast, args, entries } = await setup('first prompt');
    createSessionStore(context.dirs.state).record(TASK, SESSION);
    stub.patch(TASK, { sessionId: SESSION, next: 'resume' });
    await stub.addNote(TASK, { author: 'agent', kind: 'comment', text: 'a question' });
    await stub.addNote(TASK, { author: 'user', kind: 'comment', text: 'use the second option' });
    expect(await runWorker(context, TASK, fast)).toBe(0);
    expect(args().slice(args().indexOf('--resume'), args().indexOf('--resume') + 2)).toEqual([
      '--resume',
      SESSION,
    ]);
    expect(args()).not.toContain('--session-id');
    expect(String(entries().find((entry) => entry.kind === 'prompt')?.text)).toBe(
      'use the second option',
    );
    expect(stub.bodies('update-task').some((body) => body.next === 'fresh')).toBe(true);
  });

  it('[cli-076] refuses to resume a session this machine did not record', async () => {
    const { stub, context, fast, entries } = await setup('first prompt');
    stub.patch(TASK, { sessionId: SESSION, next: 'resume' });
    expect(await runWorker(context, TASK, fast)).toBe(1);
    expect(entries()).toHaveLength(0);
    expect(stub.tasks.get(TASK)?.status).toBe('needs-me');
    expect(await plain(stub, String(stub.bodies('fail')[0]?.body))).toContain('did not record');
  });

  it('[cli-076] a fork continues a copy of the parent session recorded on this machine', async () => {
    const { stub, context, fast, args } = await setup('fork prompt', { forkOf: 'parentAA' });
    await stub.addTask({
      id: 'parentAA',
      status: 'needs-me',
      machine: 'test-machine',
      sessionId: SESSION,
    });
    createSessionStore(context.dirs.state).record('parentAA', SESSION);
    expect(await runWorker(context, TASK, fast)).toBe(0);
    expect(args()).toEqual(expect.arrayContaining(['--resume', SESSION, '--fork-session']));
    expect(args()[args().indexOf('--session-id') + 1]).not.toBe(SESSION);
    expect(stub.tasks.get(TASK)?.sessionId).toBe(args()[args().indexOf('--session-id') + 1]);
  });

  it('[cli-076] a fork whose parent session is not on this machine is not started', async () => {
    const { stub, context, fast, entries } = await setup('fork prompt', { forkOf: 'parentAA' });
    await stub.addTask({
      id: 'parentAA',
      status: 'needs-me',
      machine: 'elsewhere',
      sessionId: SESSION,
    });
    expect(await runWorker(context, TASK, fast)).toBe(1);
    expect(entries()).toHaveLength(0);
    expect(await plain(stub, String(stub.bodies('fail')[0]?.body))).toContain(
      'forked from task parentAA',
    );
  });
});

describe('watch events and worktrees of a run', () => {
  it('[cli-064] hands a running agent the watch events left for its task and removes their files', async () => {
    const { context, entries, fast } = await setup('#hold wait');
    const store = new WatchStore(context.dirs.state);
    const done = runWorker(context, TASK, fast);
    await until(() => entries().some((entry) => entry.kind === 'prompt'), 'the prompt');
    store.writeEvent({
      id: 'ev1',
      task: TASK,
      name: 'ci',
      at: new Date().toISOString(),
      kind: 'event',
      text: 'build green',
    });
    await until(() => entries().some((entry) => entry.kind === 'later'), 'the event');
    expect(String(entries().find((entry) => entry.kind === 'later')?.text)).toContain(
      'build green',
    );
    await until(() => store.events(TASK).length === 0, 'the file to go');
    createRunRecords(context.dirs.run).requestPause(TASK, new Date());
    await done;
  });

  it('[cli-081] locks the linked worktree the task runs in and unlocks it when the task is done', async () => {
    const calls: string[][] = [];
    const worktree = tmpDir();
    const gitDir = path.join(tmpDir(), 'gitdir');
    mkdirSync(gitDir, { recursive: true });
    const { stub, context, fast, home } = await setup('quick', {});
    stub.patch(TASK, { autoDone: true });
    const exec = (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
      if (args[0] === 'rev-parse')
        return { code: 0, stdout: `${worktree}\n${gitDir}\n${path.join(home, 'common')}\n` };
      if (args[1] === 'lock') {
        writeFileSync(path.join(gitDir, 'locked'), args[3] ?? '');
        return { code: 0, stdout: '' };
      }
      if (args[1] === 'unlock') {
        writeFileSync(path.join(gitDir, 'locked'), '');
        return { code: 0, stdout: '' };
      }
      return { code: 0, stdout: '' };
    };
    const rt = {
      ...context.rt,
      exec: (file: string, args: readonly string[]) => Promise.resolve(exec(file, args)),
    };
    expect(await runWorker({ ...context, rt }, TASK, fast)).toBe(0);
    expect(calls.some((call) => call[2] === 'lock' && call.includes('rumo task taskAAAA'))).toBe(
      true,
    );
    expect(stub.tasks.get(TASK)?.status).toBe('done');
    expect(calls.some((call) => call[2] === 'unlock')).toBe(true);
  });
});

describe('the tick around the workers', () => {
  it('[cli-081] unlocks the worktrees of a task that is done and forgets them', async () => {
    const { stub, cli } = await rig({ env: PROCESS });
    await stub.addTask({ id: 'taskDDDD', status: 'done', machine: 'test-machine' });
    const state = buildContext(cli.test.rt, {}).dirs.state;
    const locks = path.join(state, 'worktree-locks');
    mkdirSync(locks, { recursive: true });
    writeFileSync(path.join(locks, 'taskDDDD.json'), JSON.stringify(['/gone/worktree']));
    expect(await cli.run('internal', 'dispatch')).toBe(0);
    expect(cli.stdout()).toContain('UNLOCK taskDDDD');
    expect(existsSync(path.join(locks, 'taskDDDD.json'))).toBe(false);
  });

  it('[cli-070] stops looking up pull requests once the time budget of the refresh is spent', async () => {
    const lookups: string[] = [];
    const { cli } = await rig({
      env: PROCESS,
      exec: async (file, args) => {
        if (file === 'gh') lookups.push(args[2] ?? '');
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { code: 0, stdout: 'OPEN\n' };
      },
    });
    const bin = tmpDir();
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n', { mode: 0o755 });
    const ctx = buildContext(cli.test.rt, {});
    const { refreshPrStatesIfDue } = await import('../src/dispatch/pr-refresh.js');
    const tasks = ['1', '2', '3'].map(
      (number) =>
        ({
          id: `pr${number}`,
          input: null,
          wire: { closed: false, status: 'todo', promptPrState: null },
          prs: [
            {
              id: `p${number}`,
              url: `https://github.com/acme/widgets/pull/${number}`,
              state: null,
            },
          ],
        }) as never,
    );
    const log: string[] = [];
    const s = { command: () => Promise.resolve(null) } as never;
    const rt = { ...ctx.rt, env: { ...ctx.rt.env, PATH: bin } };
    await refreshPrStatesIfDue(
      {
        rt,
        stateDir: ctx.dirs.state,
        now: new Date(),
        dryRun: false,
        log: (line) => log.push(line),
        budgetMs: 100,
      },
      s,
      tasks,
    );
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.length).toBeLessThan(3);
    expect(log.some((line) => line.includes('time budget'))).toBe(true);
  });
});
