import { randomUUID } from 'node:crypto';
import type http from 'node:http';

import {
  machineRoutes,
  type AnyRoute,
  type WireDirectory,
  type WireNote,
  type WireTask,
} from '@agent-board/contract';
import {
  bindings,
  decodeDataKey,
  deriveKeys,
  open,
  seal,
  type Binding,
  type Keys,
} from '@agent-board/sealing';

import { startBoard, OWNER, MACHINE, TEST_TOKEN, type FakeBoardOptions } from './board.js';
import type { Answer, SeenRequest } from './server.js';

export const DEFAULT_PROJECT = '00000000-0000-4000-8000-000000000001';

export class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StubNote {
  readonly wire: WireNote;
}

export interface TaskSeed {
  readonly id: string;
  readonly title?: string;
  readonly input?: string;
  readonly status?: WireTask['status'];
  readonly createdBy?: WireTask['createdBy'];
  readonly priority?: WireTask['priority'];
  readonly projectId?: string;
  readonly directoryId?: string | null;
  readonly machine?: string | null;
  readonly sessionId?: string | null;
  readonly closed?: boolean;
  readonly agent?: string;
  readonly lastActiveAt?: string | null;
  readonly notBefore?: string | null;
}

export interface StubRun {
  readonly id: string;
  readonly machine?: string;
  readonly resumed?: boolean;
  readonly events: readonly {
    readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'result' | 'note' | 'context';
    readonly data: Record<string, unknown>;
    readonly output?: string;
  }[];
}

export interface ApiStub {
  readonly url: string;
  readonly seen: SeenRequest[];
  readonly keys: Keys;
  readonly dataKey: string;
  readonly tasks: Map<string, WireTask>;
  readonly notes: Map<string, WireNote[]>;
  readonly directories: Map<string, WireDirectory>;
  readonly watches: Map<string, string | null>;
  commands(): string[];
  setGrant(granted: boolean): void;
  forbid(command: string): void;
  holdTask(id: string): void;
  addRun(taskId: string, run: StubRun): void;
  addQuestion(taskId: string, questions: readonly unknown[]): Promise<string>;
  seal(binding: Binding, plaintext: string): Promise<string>;
  open(binding: Binding, envelope: string): Promise<string>;
  addTask(seed: TaskSeed): Promise<WireTask>;
  addNote(
    taskId: string,
    note: { author: WireNote['author']; kind: WireNote['kind']; text: string },
  ): Promise<WireNote>;
  patch(id: string, change: Partial<WireTask>): void;
  emitTasks(): void;
  streamCount(): number;
  endStreams(): void;
  refuseToken(): void;
  stop(): Promise<void>;
}

function commandOf(route: AnyRoute): string {
  return route.path.replace('/api/machine/', '');
}

export async function startApiStub(options: FakeBoardOptions = {}): Promise<ApiStub> {
  const tasks = new Map<string, WireTask>();
  const notes = new Map<string, WireNote[]>();
  const directories = new Map<string, WireDirectory>();
  const watches = new Map<string, string | null>();
  const streams = new Set<http.ServerResponse>();
  const commands: string[] = [];
  let noteSequence = 0;
  let tokenRefused = false;
  let granted = true;
  const held = new Set<string>();
  const forbidden = new Set<string>();
  const runs = new Map<string, StubRun[]>();
  const holder: { keys?: Keys } = {};

  const requireKeys = (): Keys => {
    if (holder.keys === undefined) throw new Error('the stub is not started');
    return holder.keys;
  };

  const sealed = (binding: Binding, plaintext: string): Promise<string> =>
    seal(requireKeys(), binding, plaintext);

  const noteWire = async (
    taskId: string,
    author: WireNote['author'],
    kind: WireNote['kind'],
    text: string,
    extra: Partial<WireNote> = {},
  ): Promise<WireNote> => {
    noteSequence += 1;
    const base = {
      id: `n${noteSequence}`,
      preview: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, noteSequence)).toISOString(),
      kind,
    };
    const body =
      author === 'server'
        ? text
        : await sealed(bindings.note({ field: 'note.body', taskId, author, kind }), text);
    const wire = { ...base, author, body, ...extra } as WireNote;
    notes.set(taskId, [...(notes.get(taskId) ?? []), wire]);
    const task = tasks.get(taskId);
    if (task !== undefined) tasks.set(taskId, { ...task, noteCount: (task.noteCount ?? 0) + 1 });
    return wire;
  };

  const baseTask = async (seed: TaskSeed): Promise<WireTask> => {
    const createdBy = seed.createdBy ?? 'user';
    const agent =
      seed.agent === undefined ? null : await sealed(bindings.agent({ task: seed.id }), seed.agent);
    const directoryId = seed.directoryId ?? null;
    return {
      id: seed.id,
      title: await sealed(bindings.title({ task: seed.id }), seed.title ?? `title ${seed.id}`),
      input: await sealed(
        bindings.input({
          origin: { task: seed.id },
          creator: createdBy,
          agent: seed.agent ?? null,
          directoryId,
        }),
        seed.input ?? `prompt ${seed.id}`,
      ),
      status: seed.status ?? 'todo',
      createdBy,
      priority: seed.priority ?? 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      agent,
      icon: null,
      labels: null,
      closed: seed.closed ?? false,
      machine: seed.machine ?? null,
      sessionId: seed.sessionId ?? null,
      projectId: seed.projectId ?? DEFAULT_PROJECT,
      directoryId,
      legacyDirectory: null,
      next: 'resume',
      head: null,
      openQuestion: false,
      lane: null,
      borrowed: false,
      lastActiveAt: seed.lastActiveAt ?? null,
      runStartedAt: null,
      paused: false,
      notBefore: seed.notBefore ?? null,
      scheduleId: null,
      wakeAt: null,
      waitCheck: false,
      woken: false,
      prs: [],
      promptPrState: null,
      watches: null,
      watchStops: [],
      noteCount: 0,
    };
  };

  const gate = (id: string): WireTask => {
    if (!granted) throw new Refusal(403, 'grant-required', 'this machine has no grant');
    if (held.has(id)) throw new Refusal(409, 'run-holds-task', 'a run of this machine holds it');
    return taskOf(id);
  };

  const userNote = (
    taskId: string,
    kind: WireNote['kind'],
    message: { body: string },
    extra: Partial<WireNote> = {},
  ): void => {
    noteSequence += 1;
    const wire = {
      id: `n${noteSequence}`,
      preview: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, noteSequence)).toISOString(),
      kind,
      author: 'user',
      body: message.body,
      ...extra,
    } as WireNote;
    notes.set(taskId, [...(notes.get(taskId) ?? []), wire]);
  };

  const taskOf = (id: string): WireTask => {
    const task = tasks.get(id);
    if (task === undefined) throw new Refusal(404, 'not-found', `no task ${id}`);
    return task;
  };

  const handlers: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
    'list-tasks': (body) => ({
      tasks: [...tasks.values()].filter(
        (task) =>
          (body.all === true || !task.closed) &&
          (body.projectId === undefined || task.projectId === body.projectId),
      ),
    }),
    'get-task': (body) => taskOf(body.id as string),
    'attach-session': (body) => {
      const task = taskOf(body.id as string);
      if (task.status === 'running') throw new Refusal(409, 'conflict', 'the task is running');
      if (task.sessionId === null) throw new Refusal(409, 'conflict', 'the task has no session');
      return task;
    },
    'add-task': async (body) => {
      const id = body.id as string;
      const created = !tasks.has(id);
      if (created) {
        const draft = await baseTask({
          id,
          status: (body.status as WireTask['status'] | undefined) ?? 'backlog',
          createdBy: (body.createdBy as WireTask['createdBy'] | undefined) ?? 'agent',
          priority: (body.priority as WireTask['priority'] | undefined) ?? 'normal',
          projectId: (body.projectId as string | undefined) ?? DEFAULT_PROJECT,
          directoryId: (body.directoryId as string | null | undefined) ?? null,
          machine: (body.machine as string | undefined) ?? null,
        });
        tasks.set(id, {
          ...draft,
          title: body.title as string,
          input: body.input as string,
          icon: (body.icon as string | undefined) ?? null,
          labels: (body.labels as string | undefined) ?? null,
          requestedLane: (body.lane as string | undefined) ?? null,
          ...(body.parentId === undefined ? {} : { forkOf: undefined }),
        });
        parents.set(id, body.parentId as string | undefined);
      }
      return { task: taskOf(id), created };
    },
    'update-task': (body) => {
      const task = taskOf(body.id as string);
      if (body.expect !== undefined && body.expect !== task.status) {
        throw new Refusal(409, 'conflict', `the task is ${task.status}`);
      }
      if (body.status === 'waiting')
        throw new Refusal(400, 'bad-request', 'waiting is not a target');
      const change = Object.fromEntries(
        Object.entries(body).filter(([key]) => !['id', 'run', 'expect'].includes(key)),
      );
      const updated = { ...task, ...change } as WireTask;
      tasks.set(task.id, updated);
      return updated;
    },
    'configure-task': (body) => {
      const task = taskOf(body.id as string);
      const { place, autoDone, lane } = body;
      const rest = Object.fromEntries(
        Object.entries(body).filter(([key]) => !['id', 'place', 'autoDone', 'lane'].includes(key)),
      );
      const updated = {
        ...task,
        ...rest,
        ...(autoDone === undefined ? {} : { autoDone }),
        ...(lane === undefined ? {} : { requestedLane: lane }),
        ...(place === undefined
          ? {}
          : {
              directoryId: place === null ? null : (place as { directoryId: string }).directoryId,
            }),
      } as WireTask;
      tasks.set(task.id, updated);
      return updated;
    },
    'edit-prompt': async (body) => {
      const task = taskOf(body.id as string);
      const previous = body.previous as { body: string };
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date().toISOString(),
        kind: 'event',
        author: 'user',
        body: previous.body,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), wire]);
      const updated = { ...task, title: body.title as string, input: body.input as string };
      tasks.set(task.id, updated);
      return updated;
    },
    'add-note': (body) => {
      taskOf(body.id as string);
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, noteSequence)).toISOString(),
        kind: (body.kind as WireNote['kind'] | undefined) ?? 'comment',
        author: (body.author as WireNote['author'] | undefined) ?? 'agent',
        body: body.body as string,
        ...(body.suggestion === undefined ? {} : { suggestion: body.suggestion as string }),
      } as WireNote;
      notes.set(body.id as string, [...(notes.get(body.id as string) ?? []), wire]);
      const task = taskOf(body.id as string);
      tasks.set(task.id, { ...task, noteCount: (task.noteCount ?? 0) + 1 });
      return {};
    },
    'read-notes': (body) => {
      taskOf(body.id as string);
      return { notes: notes.get(body.id as string) ?? [] };
    },
    ask: (body) => {
      const task = taskOf(body.id as string);
      if (task.openQuestion) throw new Refusal(409, 'conflict', 'a question is already open');
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date().toISOString(),
        kind: 'question',
        author: 'agent',
        body: body.body as string,
        questions: body.questions as string,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), wire]);
      tasks.set(task.id, {
        ...task,
        openQuestion: true,
        status: 'needs-me',
        noteCount: (task.noteCount ?? 0) + 1,
      });
      return {};
    },
    'add-pr': (body) => {
      const task = taskOf(body.id as string);
      const id = `pr${task.prs.length + 1}`;
      tasks.set(task.id, {
        ...task,
        prs: [...task.prs, { id, pr: body.pr as string, state: null }],
      });
      return {};
    },
    'remove-pr': (body) => {
      const task = taskOf(body.id as string);
      tasks.set(task.id, { ...task, prs: task.prs.filter((pr) => pr.id !== body.pr) });
      return {};
    },
    'set-watches': (body) => {
      const task = taskOf(body.id as string);
      watches.set(task.id, body.watches as string | null);
      tasks.set(task.id, { ...task, watches: body.watches as string | null });
      return {};
    },
    wait: async (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the task is not running');
      noteSequence += 1;
      const waitNote = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, noteSequence)).toISOString(),
        kind: 'comment',
        author: 'agent',
        body: body.body as string,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), waitNote]);
      const updated = {
        ...task,
        status: 'waiting' as const,
        wakeAt: body.wakeAt as string,
        waitCheck: body.check as boolean,
      };
      tasks.set(task.id, updated);
      return updated;
    },
    'set-dirs': (body) => {
      const requested = body.directories as { id: string; path: string; repo: string | null }[];
      const rows = requested.map((entry) => ({
        id: entry.id,
        path: entry.path,
        repo: entry.repo,
        projectId: directories.get(entry.id)?.projectId ?? DEFAULT_PROJECT,
      }));
      directories.clear();
      for (const row of rows) directories.set(row.id, row);
      return { directories: rows };
    },
    answer: (body) => {
      const task = gate(body.id as string);
      if (!task.openQuestion) throw new Refusal(409, 'conflict', 'no open question');
      userNote(task.id, 'answer', body.message as { body: string }, {
        answers: body.answers as string,
        questionNoteId: body.questionNoteId as string,
      });
      const updated = { ...task, openQuestion: false, status: 'todo' as const };
      tasks.set(task.id, updated);
      return updated;
    },
    'dismiss-question': (body) => {
      const task = gate(body.id as string);
      if (!task.openQuestion) throw new Refusal(409, 'conflict', 'no open question');
      const updated = { ...task, openQuestion: false };
      tasks.set(task.id, updated);
      return updated;
    },
    reply: (body) => {
      const task = gate(body.id as string);
      userNote(task.id, 'comment', body.message as { body: string });
      const updated = body.resume === true ? { ...task, status: 'todo' as const } : task;
      tasks.set(task.id, updated);
      return updated;
    },
    send: (body) => {
      const task = gate(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the task is not running');
      userNote(task.id, 'comment', body.message as { body: string });
      return task;
    },
    stop: (body) => {
      const task = gate(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the task is not running');
      if (body.message !== undefined)
        userNote(task.id, 'comment', body.message as { body: string });
      const updated = { ...task, status: 'backlog' as const };
      tasks.set(task.id, updated);
      return updated;
    },
    'take-back': (body) => {
      const task = gate(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the run is not quiet');
      const updated = { ...task, status: 'todo' as const };
      tasks.set(task.id, updated);
      return updated;
    },
    rerun: (body) => {
      const task = gate(body.id as string);
      const updated = { ...task, status: 'todo' as const, next: 'fresh' as const };
      tasks.set(task.id, updated);
      return updated;
    },
    'set-closed': (body) => {
      const task = gate(body.id as string);
      const updated = { ...task, closed: body.closed as boolean };
      tasks.set(task.id, updated);
      return updated;
    },
    fork: async (body) => {
      const parent = gate(body.parentId as string);
      const draft = await baseTask({ id: body.id as string, createdBy: 'user' });
      const created = {
        ...draft,
        title: body.title as string,
        input: body.input as string,
        agent: (body.agent as string | undefined) ?? null,
        directoryId: body.directoryId as string | null,
        forkOf: parent.id,
        status: 'backlog' as const,
      };
      tasks.set(created.id, created);
      return created;
    },
    'list-runs': (body) => {
      gate(body.id as string);
      return {
        runs: (runs.get(body.id as string) ?? []).map((run) => ({
          id: run.id,
          machine: run.machine ?? MACHINE,
          sessionId: null,
          resumed: run.resumed ?? false,
          startedAt: '2026-01-01T00:00:00.000Z',
          lastEventAt: '2026-01-01T00:01:00.000Z',
          eventCount: run.events.length,
        })),
      };
    },
    'transcript-events': async (body) => {
      if (!granted) throw new Refusal(403, 'grant-required', 'this machine has no grant');
      const found = findRun(body.runId as string);
      const after = (body.afterSeq as number | undefined) ?? -1;
      const events = await Promise.all(
        found.run.events.map(async (event, seq) => ({
          seq,
          at: '2026-01-01T00:00:00.000Z',
          kind: event.kind,
          parent: null,
          data: await sealed(
            bindings.transcript({
              field: 'tr.data',
              taskId: found.taskId,
              runId: found.run.id,
              seq,
            }),
            JSON.stringify(event.data),
          ),
          outputSize: event.output === undefined ? null : event.output.length,
        })),
      );
      return { events: events.filter((event) => event.seq > after) };
    },
    'transcript-output': async (body) => {
      if (!granted) throw new Refusal(403, 'grant-required', 'this machine has no grant');
      const found = findRun(body.runId as string);
      const event = found.run.events[body.seq as number];
      return {
        output:
          event?.output === undefined
            ? null
            : await sealed(
                bindings.transcript({
                  field: 'tr.output',
                  taskId: found.taskId,
                  runId: found.run.id,
                  seq: body.seq as number,
                }),
                event.output,
              ),
      };
    },
    'list-machines': () => ({
      machines: [{ name: MACHINE, lastSeenAt: null, current: true }],
    }),
  };
  const findRun = (runId: string): { taskId: string; run: StubRun } => {
    for (const [taskId, list] of runs) {
      const run = list.find((candidate) => candidate.id === runId);
      if (run !== undefined) return { taskId, run };
    }
    throw new Refusal(404, 'not-found', `no run ${runId}`);
  };
  const parents = new Map<string, string | undefined>();

  const board = await startBoard({
    ...options,
    extra: async (request): Promise<Answer | undefined> => {
      const pathname = request.path.split('?')[0] ?? '';
      if (request.method === 'GET' && pathname === '/api/machine/events') {
        if (tokenRefused || request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
          return { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } };
        }
        commands.push('events');
        return {
          stream: (response) => {
            streams.add(response);
            response.write(': open\n\n');
            response.on('close', () => streams.delete(response));
          },
        };
      }
      const route = machineRoutes.find(
        (candidate) => candidate.path === pathname && candidate.method === request.method,
      );
      if (route === undefined) return options.extra?.(request);
      if (tokenRefused || request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
        return { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } };
      }
      const handler = handlers[commandOf(route)];
      if (handler === undefined) {
        return { status: 404, body: { error: { code: 'not-found', message: 'not stubbed' } } };
      }
      let parsedBody: unknown;
      try {
        parsedBody = request.body === '' ? {} : JSON.parse(request.body);
      } catch {
        return { status: 400, body: { error: { code: 'bad-request', message: 'not JSON' } } };
      }
      const parsed = route.request.safeParse(parsedBody);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: { code: 'bad-request', message: parsed.error.message } },
        };
      }
      commands.push(commandOf(route));
      if (forbidden.has(commandOf(route))) {
        return { status: 403, body: { error: { code: 'forbidden', message: 'not for you' } } };
      }
      try {
        const result = await handler(parsed.data as Record<string, unknown>);
        return { body: route.response.parse(result) };
      } catch (error) {
        if (error instanceof Refusal) {
          return {
            status: error.status,
            body: { error: { code: error.code, message: error.message } },
          };
        }
        throw error;
      }
    },
  });

  const keys = await deriveKeys(decodeDataKey(board.dataKey), OWNER);
  holder.keys = keys;

  return {
    url: board.url,
    seen: board.seen,
    keys,
    dataKey: board.dataKey,
    tasks,
    notes,
    directories,
    watches,
    commands: () => commands,
    setGrant: (value) => {
      granted = value;
    },
    forbid: (command) => {
      forbidden.add(command);
    },
    holdTask: (id) => {
      held.add(id);
    },
    addRun: (taskId, run) => {
      runs.set(taskId, [...(runs.get(taskId) ?? []), run]);
    },
    addQuestion: async (taskId, questions) => {
      const wire = await noteWire(taskId, 'agent', 'question', 'questions', {
        questions: await sealed(
          bindings.note({ field: 'note.questions', taskId, author: 'agent', kind: 'question' }),
          JSON.stringify({ questions }),
        ),
      });
      tasks.set(taskId, { ...taskOf(taskId), openQuestion: true, status: 'needs-me' });
      return wire.id;
    },
    seal: sealed,
    open: (binding, envelope) => open(requireKeys(), binding, envelope),
    addTask: async (seed) => {
      const wire = await baseTask(seed);
      tasks.set(seed.id, wire);
      return wire;
    },
    addNote: (taskId, note) => noteWire(taskId, note.author, note.kind, note.text),
    patch: (id, change) => {
      tasks.set(id, { ...taskOf(id), ...change });
    },
    emitTasks: () => {
      for (const response of streams) response.write('event: tasks\ndata: {}\n\n');
    },
    streamCount: () => streams.size,
    endStreams: () => {
      for (const response of streams) response.end();
    },
    refuseToken: () => {
      tokenRefused = true;
      for (const response of streams) response.end();
    },
    stop: board.stop,
  };
}

export { OWNER, MACHINE, TEST_TOKEN, randomUUID };
