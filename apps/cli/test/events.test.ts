import { describe, expect, it } from 'vitest';

import { EVENT_TYPES, matchesFilter, type BoardEvent } from '../src/events/diff.js';
import { runEvents } from '../src/events/run.js';
import { MAX_SSE_LINE, readSse } from '../src/transport/stream.js';
import type { ApiStub } from './support/api-stub.js';
import { useRig } from './support/harness.js';
import type { Cli } from './support/profile.js';

const rig = useRig();

interface Line {
  type: string;
  task: string;
  status?: string;
  actor?: string;
  machine?: string | null;
  project?: string;
  from?: string;
  to?: string;
  fields?: string[];
  note?: { text: string | null; author: string };
}

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const lines = (cli: Cli): Line[] =>
  cli
    .stdout()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Line);

async function listening(args: string[], seed?: (stub: ApiStub) => Promise<void>) {
  const abort = new AbortController();
  const { stub, cli } = await rig({ interrupt: abort.signal });
  await seed?.(stub);
  const done = cli.run('events', '--json', ...args);
  await until(() => cli.stderr().includes('connected'), 'the event stream to connect');
  await until(() => stub.streamCount() > 0, 'the stream');
  return {
    stub,
    cli,
    change: async (action: () => void | Promise<void>) => {
      await action();
      stub.emitTasks();
    },
    stop: async () => {
      abort.abort();
      return done;
    },
  };
}

describe('rumo events', () => {
  it('[cli-023] reports a created task, its moves and its changes after the first look, and exits 0 on interrupt', async () => {
    const run = await listening([]);
    await run.change(async () => {
      await run.stub.addTask({
        id: 'taskAAAA',
        title: 'watched',
        status: 'backlog',
        machine: 'test-machine',
      });
    });
    await until(() => lines(run.cli).some((line) => line.type === 'created'), 'created');
    await run.change(() => {
      run.stub.patch('taskAAAA', { status: 'todo', movedBy: 'user' });
    });
    await until(() => lines(run.cli).some((line) => line.type === 'moved'), 'moved');
    await run.change(() => {
      run.stub.patch('taskAAAA', { priority: 'high' });
    });
    await until(() => lines(run.cli).some((line) => line.type === 'changed'), 'changed');
    expect(await run.stop()).toBe(0);
    const [created, moved, changed] = lines(run.cli);
    expect(created).toMatchObject({
      type: 'created',
      task: 'taskAAAA',
      status: 'backlog',
      machine: 'test-machine',
    });
    expect(created?.project).toMatch(/^[0-9a-f-]{36}$/);
    expect(moved).toMatchObject({
      type: 'moved',
      from: 'backlog',
      to: 'todo',
      status: 'todo',
      actor: 'user',
    });
    expect(changed).toMatchObject({ type: 'changed', fields: ['priority'] });
  });

  it('[cli-023] prints nothing for what was there at the first look', async () => {
    const run = await listening([], async (stub) => {
      await stub.addTask({ id: 'taskAAAA', status: 'todo' });
    });
    run.stub.emitTasks();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await run.stop()).toBe(0);
    expect(run.cli.stdout()).toBe('');
  });

  it('[cli-023] reports a new note with its text, a closed task and a deleted task', async () => {
    const run = await listening([], async (stub) => {
      await stub.addTask({ id: 'taskAAAA', status: 'todo' });
      await stub.addTask({ id: 'taskBBBB', status: 'todo' });
    });
    await run.change(async () => {
      await run.stub.addNote('taskAAAA', { author: 'agent', kind: 'comment', text: 'hello there' });
    });
    await until(() => lines(run.cli).some((line) => line.type === 'note'), 'note');
    await run.change(() => {
      run.stub.patch('taskAAAA', { closed: true });
      run.stub.tasks.delete('taskBBBB');
    });
    await until(() => lines(run.cli).length >= 3, 'closed and removed');
    await run.stop();
    expect(lines(run.cli).map((line) => [line.type, line.task])).toEqual(
      expect.arrayContaining([
        ['note', 'taskAAAA'],
        ['closed', 'taskAAAA'],
        ['removed', 'taskBBBB'],
      ]),
    );
    expect(lines(run.cli).find((line) => line.type === 'note')?.note).toMatchObject({
      text: 'hello there',
      author: 'agent',
    });
  });

  const projectA = '00000000-0000-4000-8000-0000000000aa';
  const filters: { args: string[]; keeps: (line: Line) => boolean }[] = [
    { args: ['--task', 'wanted01'], keeps: (line) => line.task === 'wanted01' },
    { args: ['--status', 'todo'], keeps: (line) => line.status === 'todo' },
    { args: ['--type', 'moved'], keeps: (line) => line.type === 'moved' },
    { args: ['--actor', 'user'], keeps: (line) => line.actor === 'user' },
    { args: ['--machine', 'm-one'], keeps: (line) => line.machine === 'm-one' },
    { args: ['--project', projectA], keeps: (line) => line.project === projectA },
  ];

  it.each(filters)('[cli-023] $args.0 keeps only what matches', async ({ args, keeps }) => {
    const run = await listening(args, async (stub: ApiStub) => {
      await stub.addTask({
        id: 'wanted01',
        status: 'backlog',
        machine: 'm-one',
        projectId: projectA,
      });
      await stub.addTask({ id: 'other001', status: 'backlog', machine: 'm-two' });
    });
    await run.change(() => {
      run.stub.patch('other001', { priority: 'high' });
      run.stub.patch('wanted01', { status: 'todo', movedBy: 'user' });
    });
    await until(() => lines(run.cli).length > 0, `an event for ${args.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await run.stop();
    const seen = lines(run.cli);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(keeps)).toBe(true);
    expect(seen.some((line) => line.task === 'other001')).toBe(false);
  });

  it('[cli-023] prints one readable line per event without --json', async () => {
    const abort = new AbortController();
    const { stub, cli } = await rig({ interrupt: abort.signal });
    await stub.addTask({ id: 'taskAAAA', title: 'the title', status: 'todo' });
    const done = cli.run('events');
    await until(() => cli.stderr().includes('connected'), 'connect');
    await until(() => stub.streamCount() > 0, 'stream');
    stub.patch('taskAAAA', { status: 'needs-me', movedBy: 'agent' });
    stub.emitTasks();
    await until(() => cli.stdout().includes('moved'), 'the moved line');
    abort.abort();
    await done;
    expect(cli.stdout()).toMatch(
      /\d\d:\d\d:\d\d {2}moved +taskAAAA +todo → needs-me by agent {2}the title\n/,
    );
  });

  it('[cli-023] exits 1 when the board refuses the token on the stream', async () => {
    const { stub, cli } = await rig();
    stub.refuseToken();
    expect(await cli.run('events')).toBe(1);
    expect(cli.stderr()).toContain('refused this machine token');
  });

  it('[cli-023] exits 1 when the token is refused at the handshake and refuses to run inside a run', async () => {
    const wrong = await rig({ env: { RUMO_TOKEN: 'abm_wrongtoken' } });
    expect(await wrong.cli.run('events')).toBe(1);
    const inRun = await rig({ env: { RUMO_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('events')).toBe(2);
  });

  it('[cli-023] refuses an unknown type, actor and status before connecting', async () => {
    const { stub, cli } = await rig();
    expect(await cli.run('events', '--type', 'exploded')).toBe(2);
    expect(await cli.run('events', '--actor', 'nobody')).toBe(2);
    expect(await cli.run('events', '--status', 'later')).toBe(2);
    expect(await cli.run('events', '--project', 'nope')).toBe(2);
    expect(stub.commands()).not.toContain('events');
  });

  it('[cli-023] lists the six event types', () => {
    expect(EVENT_TYPES).toEqual(['created', 'moved', 'changed', 'closed', 'removed', 'note']);
  });
});

describe('the event loop', () => {
  const never = (signal: AbortSignal) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });

  function streamOf(chunks: string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
    );
  }

  it('[cli-023] reconnects with a backoff after the stream closes and lists again at each signal', async () => {
    const abort = new AbortController();
    let opened = 0;
    let listed = 0;
    const logs: string[] = [];
    const code = await runEvents({
      openStream: (signal) => {
        opened += 1;
        if (opened === 3) {
          abort.abort();
          return never(signal);
        }
        return Promise.resolve(streamOf([': ping\n\n', 'event: tasks\ndata: {}\n\n']));
      },
      list: () => {
        listed += 1;
        return Promise.resolve([]);
      },
      readNotes: () => Promise.resolve([]),
      fetchLeft: () => Promise.resolve(null),
      filter: { tasks: [], statuses: [], types: [], actors: [] },
      emit: () => undefined,
      log: (line) => logs.push(line),
      now: () => new Date(),
      signal: abort.signal,
      timing: { debounceMs: 1, pollMs: 60_000, backoffBaseMs: 1, backoffMaxMs: 2, idleMs: 60_000 },
    });
    expect(code).toBe(0);
    expect(opened).toBe(3);
    expect(listed).toBeGreaterThanOrEqual(2);
    expect(logs.filter((line) => line.includes('reconnecting'))).toHaveLength(2);
  });

  it('[cli-023] lists again on the poll timer when no signal arrives', async () => {
    const abort = new AbortController();
    let listed = 0;
    const code = await runEvents({
      openStream: () =>
        Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {} }))),
      list: () => {
        listed += 1;
        if (listed === 3) abort.abort();
        return Promise.resolve([]);
      },
      readNotes: () => Promise.resolve([]),
      fetchLeft: () => Promise.resolve(null),
      filter: { tasks: [], statuses: [], types: [], actors: [] },
      emit: () => undefined,
      log: () => undefined,
      now: () => new Date(),
      signal: abort.signal,
      timing: { debounceMs: 1, pollMs: 5, backoffBaseMs: 1, backoffMaxMs: 2, idleMs: 60_000 },
    });
    expect(code).toBe(0);
    expect(listed).toBe(3);
  });

  it('[cli-023] reads server-sent events split across chunks and ignores comments', async () => {
    const seen: string[] = [];
    for await (const message of readSse(
      streamOf([': ping\n\nevent: tas', 'ks\ndata: {}\r\n\r\nevent: other\ndata: x\ndata: y\n\n'])
        .body as ReadableStream<Uint8Array>,
    )) {
      seen.push(`${message.event}:${message.data}`);
    }
    expect(seen).toEqual(['tasks:{}', 'other:x\ny']);
  });

  it('[cli-023] stops reading an event stream that sends a line without end', async () => {
    const huge = 'x'.repeat(MAX_SSE_LINE + 1);
    const read = async (): Promise<void> => {
      for await (const message of readSse(
        streamOf([`data: ${huge}`]).body as ReadableStream<Uint8Array>,
      )) {
        void message;
      }
    };
    await expect(read()).rejects.toThrow('longer than 1 MiB');
  });

  it('[cli-023] matches a filter on every field', () => {
    const event = {
      type: 'moved',
      status: 'todo',
      actor: 'user',
      task: { id: 'a', wire: { machine: 'm', projectId: 'p' } },
    } as unknown as BoardEvent;
    expect(
      matchesFilter(event, {
        tasks: ['a'],
        statuses: ['todo'],
        types: ['moved'],
        actors: ['user'],
        machine: 'm',
        project: 'p',
      }),
    ).toBe(true);
    expect(matchesFilter(event, { tasks: ['b'], statuses: [], types: [], actors: [] })).toBe(false);
    expect(
      matchesFilter({ ...event, actor: undefined } as unknown as BoardEvent, {
        tasks: [],
        statuses: [],
        types: [],
        actors: ['user'],
      }),
    ).toBe(false);
  });
});
