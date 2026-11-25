import { randomUUID } from 'node:crypto';
import type http from 'node:http';

import {
  machineRoutes,
  type AnyRoute,
  type WireDirectory,
  type WireNote,
  type WireSchedule,
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
  readonly forkOf?: string;
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

export interface TranscriptUpload {
  readonly runId: string;
  readonly sessionId: string | null;
  readonly resumed: boolean;
  readonly events: readonly { seq: number; kind: string; data: string; output?: string }[];
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
  readonly schedules: Map<string, WireSchedule>;
  readonly converted: { directories: { id: string; path: string }[]; assign: unknown[] }[];
  readonly published: { feeds: string[]; agents: { version: number; document: string }[] };
  setLegacy(
    document: string | null,
    uses: { kind: 'task' | 'schedule'; id: string; legacyDirectory: string }[],
  ): void;
  setBoardAgents(version: number, document: string): void;
  commands(): string[];
  bodies(command: string): Record<string, unknown>[];
  setFeedRequests(requests: readonly string[]): void;
  setAdvertisedCli(version: string | null): void;
  setGrant(granted: boolean): void;
  setMachines(machines: readonly { name: string; lastSeenAt: string | null }[]): void;
  forbid(command: string): void;
  holdTask(id: string): void;
  addRun(taskId: string, run: StubRun): void;
  sendToRun(taskId: string, text: string): Promise<void>;
  requestStop(taskId: string): void;
  uploads(taskId: string): TranscriptUpload[];
  setTitleRules(version: number, document: string): Promise<void>;
  readonly titleChanges: Record<string, unknown>[];
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
  revocations(): number;
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
  const schedules = new Map<string, WireSchedule>();
  const converted: ApiStub['converted'] = [];
  const published: ApiStub['published'] = { feeds: [], agents: [] };
  const dedupe = new Map<string, string>();
  const legacy: {
    document: string | null;
    uses: { kind: 'task' | 'schedule'; id: string; legacyDirectory: string }[];
  } = { document: null, uses: [] };
  let boardAgents: { version: number; document: string } | null = null;
  let feedsIndex: string | null = null;
  const streams = new Set<http.ServerResponse>();
  const commands: string[] = [];
  let noteSequence = 0;
  let tokenRefused = false;
  let revocations = 0;
  let granted = true;
  let peers: readonly { name: string; lastSeenAt: string | null }[] = [];
  const held = new Set<string>();
  const bodiesOf = new Map<string, Record<string, unknown>[]>();
  let feedRequests: readonly string[] = [];
  let advertisedCli: string | null = null;
  let usageIndex: string | null = null;
  let runCounter = 0;
  const forbidden = new Set<string>();
  const runs = new Map<string, StubRun[]>();
  const stopRequests = new Set<string>();
  const transcriptUploads = new Map<string, TranscriptUpload[]>();
  const titleChanges: Record<string, unknown>[] = [];
  let titleRules: { version: number; document: string } | null = null;
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
          forkOf: seed.forkOf ?? null,
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
      ...(seed.forkOf === undefined ? {} : { forkOf: seed.forkOf }),
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

  const scheduleOf = (id: string): WireSchedule => {
    const found = schedules.get(id);
    if (found === undefined) throw new Refusal(404, 'not-found', `no schedule ${id}`);
    return found;
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
      const key = body.dedupeKey as string | undefined;
      const existingId = key === undefined ? undefined : dedupe.get(key);
      if (existingId !== undefined) return { task: taskOf(existingId), created: false };
      const created = !tasks.has(id);
      if (created) {
        if (key !== undefined) dedupe.set(key, id);
        const draft = await baseTask({
          id,
          status: (body.status as WireTask['status'] | undefined) ?? 'backlog',
          createdBy: (body.createdBy as WireTask['createdBy'] | undefined) ?? 'agent',
          notBefore: (body.notBefore as string | undefined) ?? null,
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
          agent: (body.agent as string | undefined) ?? null,
          model: (body.model as string | undefined) ?? null,
          effort: (body.effort as WireTask['effort'] | undefined) ?? null,
          autoDone: body.autoDone === true,
          head: (body.head as string | undefined) ?? null,
          next: 'fresh',
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
      const requested = body.directories as {
        id: string;
        path: string;
        repo: string | null;
        projectId?: string;
      }[];
      const kept = new Set(requested.map((entry) => entry.id));
      for (const id of directories.keys()) {
        const used = [...tasks.values()].some(
          (task) => task.directoryId === id && task.status !== 'done',
        );
        if (!kept.has(id) && used) {
          throw new Refusal(409, 'directory-in-use', 'open tasks use that directory');
        }
      }
      const rows = requested.map((entry) => ({
        id: entry.id,
        path: entry.path,
        repo: entry.repo,
        projectId: directories.get(entry.id)?.projectId ?? entry.projectId ?? DEFAULT_PROJECT,
      }));
      directories.clear();
      for (const row of rows) directories.set(row.id, row);
      return { directories: rows };
    },
    'list-schedules': () => ({ schedules: [...schedules.values()] }),
    'add-schedule': async (body) => {
      const id = body.id as string;
      const startAt = body.startAt as string | undefined;
      const every = body.everyMs as number | undefined;
      const wire = {
        id,
        title: body.title as string,
        input: body.input as string,
        agent: (body.agent as string | undefined) ?? null,
        icon: (body.icon as string | undefined) ?? null,
        labels: (body.labels as string | undefined) ?? null,
        priority: (body.priority as WireSchedule['priority'] | undefined) ?? 'normal',
        model: (body.model as string | undefined) ?? null,
        effort: (body.effort as WireSchedule['effort'] | undefined) ?? null,
        requestedLane: (body.lane as string | undefined) ?? null,
        autoDone: body.autoDone === true,
        machine: (body.machine as string | undefined) ?? null,
        projectId: (body.projectId as string | undefined) ?? DEFAULT_PROJECT,
        directoryId: (body.directoryId as string | undefined) ?? null,
        legacyDirectory: null,
        everyMs: every ?? null,
        cron: (body.cron as string | undefined) ?? null,
        moreCrons: (body.moreCrons as string[] | undefined) ?? [],
        timezone: (body.timezone as string | undefined) ?? null,
        after:
          body.after === undefined
            ? null
            : {
                scheduleId: (body.after as { scheduleId: string }).scheduleId,
                delayMs: (body.after as { delayMs?: number }).delayMs ?? 0,
              },
        maxConcurrent: (body.maxConcurrent as number | undefined) ?? null,
        anchorAt: startAt ?? '2026-01-01T00:00:00.000Z',
        nextRunAt: body.after === undefined ? (startAt ?? '2026-01-01T01:00:00.000Z') : null,
        remaining: (body.times as number | undefined) ?? null,
        until: (body.until as string | undefined) ?? null,
        paused: false,
        ended: false,
        occurrenceTaskId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      } satisfies WireSchedule;
      schedules.set(id, wire);
      if (body.after !== undefined) return { schedule: wire, task: null };
      const draft = await baseTask({ id: `occ-${id}`, status: 'todo', createdBy: 'user' });
      tasks.set(draft.id, { ...draft, scheduleId: id, notBefore: wire.nextRunAt });
      return { schedule: wire, task: tasks.get(draft.id) };
    },
    'update-schedule': (body) => {
      const wire = scheduleOf(body.id as string);
      const next = { ...wire, paused: body.paused === true };
      schedules.set(wire.id, next);
      return next;
    },
    'edit-schedule': (body) => {
      const wire = scheduleOf(body.id as string);
      const settings = body.settings as
        | {
            place: { machine: string; directoryId: string } | null;
            priority: WireSchedule['priority'];
            model: string | null;
            effort?: WireSchedule['effort'];
            lane?: string | null;
            autoDone: boolean;
            repeat: { everyMs?: number; cron?: string; moreCrons?: string[]; timezone?: string };
            runsLeft: number | null;
            until: string | null;
            maxConcurrent: number | null;
            agent?: string;
            icon?: string | null;
            labels?: string | null;
          }
        | undefined;
      const next = {
        ...wire,
        title: body.title as string,
        input: body.input as string,
        ...(settings === undefined
          ? {}
          : {
              machine: settings.place?.machine ?? null,
              directoryId: settings.place?.directoryId ?? null,
              priority: settings.priority,
              model: settings.model,
              effort: settings.effort ?? null,
              requestedLane: settings.lane ?? null,
              autoDone: settings.autoDone,
              everyMs: settings.repeat.everyMs ?? null,
              cron: settings.repeat.cron ?? null,
              moreCrons: settings.repeat.moreCrons ?? [],
              timezone: settings.repeat.timezone ?? null,
              remaining: settings.runsLeft,
              until: settings.until,
              maxConcurrent: settings.maxConcurrent,
              agent: settings.agent ?? null,
              icon: settings.icon ?? null,
              labels: settings.labels ?? null,
            }),
      } as WireSchedule;
      schedules.set(wire.id, next);
      return { schedule: next, pending: 'updated' };
    },
    'remove-schedule': (body) => {
      scheduleOf(body.id as string);
      schedules.delete(body.id as string);
      return {};
    },
    'claim-task': (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'todo') throw new Refusal(409, 'conflict', `the task is ${task.status}`);
      if (task.createdBy === 'agent') throw new Refusal(409, 'conflict', 'an agent proposed this');
      if (task.notBefore !== null && Date.parse(task.notBefore) > Date.now()) {
        throw new Refusal(409, 'conflict', 'the task is not due yet');
      }
      if (
        task.machine !== null &&
        task.machine !== body.machine &&
        (task.directoryId !== null || (task.next === 'resume' && task.sessionId !== null))
      ) {
        throw new Refusal(409, 'conflict', `the task is pinned to ${task.machine}`);
      }
      runCounter += 1;
      const claimed = {
        ...task,
        status: 'running' as const,
        machine: body.machine as string,
        run: `run${String(runCounter).padStart(16, '0')}`,
        runStartedAt: new Date().toISOString(),
      };
      tasks.set(task.id, claimed);
      return claimed;
    },
    heartbeat: (body) => {
      taskOf(body.id as string);
      return {};
    },
    fail: async (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'running') return { applied: false, task };
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date().toISOString(),
        kind: 'event',
        author: 'system',
        body: body.body as string,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), wire]);
      const updated = { ...task, status: 'needs-me' as const };
      tasks.set(task.id, updated);
      return { applied: true, task: updated };
    },
    pause: (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the task is not running');
      const updated = { ...task, status: 'todo' as const, paused: true };
      tasks.set(task.id, updated);
      return updated;
    },
    wake: (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'waiting') return { applied: false, task };
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date().toISOString(),
        kind: 'event',
        author: 'system',
        body: body.body as string,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), wire]);
      const updated = { ...task, status: 'todo' as const };
      tasks.set(task.id, updated);
      return { applied: true, task: updated };
    },
    'run-inbox': (body) => {
      const task = taskOf(body.id as string);
      if (task.status !== 'running') throw new Refusal(409, 'conflict', 'the task is not running');
      return {
        stop: stopRequests.has(task.id),
        messages: (notes.get(task.id) ?? []).filter((note) => note.pending === true),
      };
    },
    'ack-messages': (body) => {
      const id = body.id as string;
      const acknowledged = new Set(body.ids as string[]);
      notes.set(
        id,
        (notes.get(id) ?? []).map((note) =>
          acknowledged.has(note.id) ? ({ ...note, pending: false } as WireNote) : note,
        ),
      );
      if (body.stop === true) stopRequests.delete(id);
      return {};
    },
    stopped: async (body) => {
      const task = taskOf(body.id as string);
      noteSequence += 1;
      const wire = {
        id: `n${noteSequence}`,
        preview: null,
        createdAt: new Date().toISOString(),
        kind: 'event',
        author: 'system',
        body: body.body as string,
      } as WireNote;
      notes.set(task.id, [...(notes.get(task.id) ?? []), wire]);
      const updated = { ...task, status: 'needs-me' as const };
      tasks.set(task.id, updated);
      return updated;
    },
    transcript: (body) => {
      const id = body.id as string;
      taskOf(id);
      const batch = body.events as {
        seq: number;
        kind: string;
        data: string;
        output?: string;
      }[];
      const list = transcriptUploads.get(id) ?? [];
      const found = list.find((upload) => upload.runId === body.runId);
      const events = [...(found?.events ?? []), ...batch];
      const next = {
        runId: body.runId as string,
        sessionId: body.sessionId as string | null,
        resumed: body.resumed as boolean,
        events,
      };
      transcriptUploads.set(id, [...list.filter((upload) => upload !== found), next]);
      return {};
    },
    'get-title-rules': () => ({ titleRules }),
    'apply-title-rule': (body) => {
      titleChanges.push(body);
      return {
        icon: body.icon !== undefined,
        labels: body.labels !== undefined,
        title: body.title !== undefined,
      };
    },
    'set-usage': (body) => {
      usageIndex = body.index as string;
      return {};
    },
    'ack-feed-requests': (body) => {
      const acked = new Set(body.requests as string[]);
      feedRequests = feedRequests.filter((request) => !acked.has(request));
      return {};
    },
    'ack-watch-stops': (body) => {
      const task = taskOf(body.id as string);
      tasks.set(task.id, { ...task, watchStops: [] });
      return {};
    },
    'set-pr-states': (body) => {
      const task = taskOf(body.id as string);
      const states = new Map(
        ((body.prs as { id: string; state: WireTask['promptPrState'] }[] | undefined) ?? []).map(
          (entry) => [entry.id, entry.state],
        ),
      );
      tasks.set(task.id, {
        ...task,
        promptPrState: (body.prompt as WireTask['promptPrState'] | undefined) ?? task.promptPrState,
        prs: task.prs.map((pr) => ({ ...pr, state: states.get(pr.id) ?? pr.state })),
      });
      return {};
    },
    'revoke-token': () => {
      tokenRefused = true;
      revocations += 1;
      return {};
    },
    'get-legacy-dirs': () => ({ document: legacy.document, tasks: legacy.uses }),
    'convert-legacy-dirs': (body) => {
      const incoming = body.directories as { id: string; path: string; repo: string | null }[];
      const assign = body.assign as {
        kind: 'task' | 'schedule';
        id: string;
        directoryId: string;
      }[];
      let inserted = 0;
      for (const row of incoming) {
        if (directories.has(row.id)) continue;
        directories.set(row.id, { ...row, projectId: DEFAULT_PROJECT });
        inserted += 1;
      }
      for (const pair of assign) {
        if (pair.kind === 'task') {
          const task = tasks.get(pair.id);
          if (task !== undefined) tasks.set(pair.id, { ...task, directoryId: pair.directoryId });
        }
      }
      converted.push({ directories: incoming, assign });
      legacy.document = null;
      legacy.uses = [];
      return { inserted, assigned: assign.length };
    },
    'get-agents': () => ({ agents: boardAgents }),
    'set-agents': (body) => {
      const expected = body.expectedVersion as number;
      if ((boardAgents?.version ?? 0) !== expected) {
        throw new Refusal(409, 'version-conflict', 'the board agents changed');
      }
      boardAgents = { version: body.version as number, document: body.document as string };
      published.agents.push(boardAgents);
      return {};
    },
    'set-feeds': (body) => {
      published.feeds.push(body.feeds as string);
      feedsIndex = body.index as string;
      return {};
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
      machines: [
        { name: MACHINE, lastSeenAt: null, current: true },
        ...peers.map((peer) => ({ ...peer, current: false })),
      ],
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
    machineVersion: () => ({
      legacyDirs: legacy.document !== null,
      agentsVersion: boardAgents?.version ?? null,
      feedsIndex,
      usageIndex,
      feedRequests,
      cli: advertisedCli,
    }),
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
      bodiesOf.set(commandOf(route), [
        ...(bodiesOf.get(commandOf(route)) ?? []),
        parsed.data as Record<string, unknown>,
      ]);
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
    schedules,
    converted,
    published,
    setLegacy: (document, uses) => {
      legacy.document = document;
      legacy.uses = uses;
    },
    setBoardAgents: (version, document) => {
      boardAgents = { version, document };
    },
    commands: () => commands,
    bodies: (command) => bodiesOf.get(command) ?? [],
    setFeedRequests: (requests) => {
      feedRequests = requests;
    },
    setAdvertisedCli: (version) => {
      advertisedCli = version;
    },
    setGrant: (value) => {
      granted = value;
    },
    setMachines: (machines) => {
      peers = machines;
    },
    forbid: (command) => {
      forbidden.add(command);
    },
    holdTask: (id) => {
      held.add(id);
    },
    sendToRun: async (taskId, text) => {
      await noteWire(taskId, 'user', 'comment', text, { pending: true });
    },
    requestStop: (taskId) => {
      stopRequests.add(taskId);
    },
    uploads: (taskId) => transcriptUploads.get(taskId) ?? [],
    setTitleRules: async (version, document) => {
      titleRules = { version, document: await sealed(bindings.titles(version), document) };
    },
    titleChanges,
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
    revocations: () => revocations,
    refuseToken: () => {
      tokenRefused = true;
      for (const response of streams) response.end();
    },
    stop: board.stop,
  };
}

export { OWNER, MACHINE, TEST_TOKEN, randomUUID };
