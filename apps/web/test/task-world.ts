import {
  clientTranscriptEventsRoute,
  clientTranscriptOutputRoute,
  clientTranscriptRunsRoute,
  configureClientTaskRoute,
  getClientTaskRoute,
  listClientDirectoriesRoute,
  removePrClientTaskRoute,
  setPriorityClientTaskRoute,
  setProjectClientTaskRoute,
  stopWatchClientTaskRoute,
  type NoteKind,
  type UiTaskListItem,
} from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { json } from './fake-board.js';
import { BoardWorld, OWNER_KEYS, hours, isoAt, minutes, type SeedTask } from './board-world.js';

export const PROJECT_HOME = '11111111-1111-4111-8111-111111111111';
export const PROJECT_WORK = '22222222-2222-4222-8222-222222222222';
export const DIRECTORY_REPO = '33333333-3333-4333-8333-333333333333';
export const DIRECTORY_DOCS = '44444444-4444-4444-8444-444444444444';
export const SESSION = '55555555-5555-4555-8555-555555555555';

export interface SeedNote {
  readonly id: string;
  readonly author: 'user' | 'agent' | 'system' | 'server';
  readonly kind?: NoteKind;
  readonly body: string;
  readonly by?: string | null;
  readonly questions?: unknown;
  readonly answers?: unknown;
  readonly pending?: boolean;
  readonly queued?: boolean;
  readonly deliveredAt?: string;
  readonly ageMinutes?: number;
}

export interface SeedEvent {
  readonly seq: number;
  readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'note' | 'context';
  readonly data: Readonly<Record<string, unknown>>;
  readonly parent?: string;
  readonly output?: string;
}

interface StoredEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: SeedEvent['kind'];
  readonly parent: string | null;
  readonly data: string;
  readonly output: string | null;
  readonly outputSize: number | null;
}

const taskOnly = (task: UiTaskListItem) =>
  Object.fromEntries(
    Object.entries(task).filter(([key]) => key !== 'lastNote' && key !== 'context'),
  );

export class TaskWorld extends BoardWorld {
  readonly threads = new Map<string, unknown[]>();
  readonly runs = new Map<string, { id: string; machine: string; startedAt: string }[]>();
  readonly events = new Map<string, StoredEvent[]>();
  directories: { id: string; path: string }[] = [];
  readonly requests: string[] = [];
  readonly priorities: Record<string, unknown>[] = [];
  readonly projectChanges: Record<string, unknown>[] = [];
  readonly prRemovals: Record<string, unknown>[] = [];
  readonly watchStopped: Record<string, unknown>[] = [];

  task(id: string): UiTaskListItem {
    const found = this.tasks.find((task) => task.id === id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
  }

  async seedNotes(taskId: string, notes: readonly SeedNote[]): Promise<void> {
    const keys = await OWNER_KEYS;
    const sealed = [];
    for (const note of notes) {
      const kind = note.kind ?? 'comment';
      const field = (name: 'note.body' | 'note.questions' | 'note.answers') =>
        note.author === 'server'
          ? null
          : bindings.note({ field: name, taskId, author: note.author, kind });
      const bodyBinding = field('note.body');
      const questionsBinding = field('note.questions');
      const answersBinding = field('note.answers');
      sealed.push({
        id: note.id,
        preview: null,
        createdAt: isoAt(-minutes(note.ageMinutes ?? 30)),
        kind,
        author: note.author,
        by: note.by ?? null,
        body: bodyBinding === null ? note.body : await seal(keys, bodyBinding, note.body),
        ...(note.questions === undefined || questionsBinding === null
          ? {}
          : { questions: await seal(keys, questionsBinding, JSON.stringify(note.questions)) }),
        ...(note.answers === undefined || answersBinding === null
          ? {}
          : { answers: await seal(keys, answersBinding, JSON.stringify(note.answers)) }),
        ...(note.pending === undefined ? {} : { pending: note.pending }),
        ...(note.queued === undefined ? {} : { queued: note.queued }),
        ...(note.deliveredAt === undefined ? {} : { deliveredAt: note.deliveredAt }),
      });
    }
    this.threads.set(taskId, [...(this.threads.get(taskId) ?? []), ...sealed]);
  }

  async seedRun(taskId: string, runId: string, events: readonly SeedEvent[] = []): Promise<void> {
    this.runs.set(taskId, [
      ...(this.runs.get(taskId) ?? []),
      { id: runId, machine: 'laptop', startedAt: isoAt(-hours(1)) },
    ]);
    await this.addEvents(taskId, runId, events);
  }

  async addEvents(taskId: string, runId: string, events: readonly SeedEvent[]): Promise<void> {
    const keys = await OWNER_KEYS;
    const stored = [...(this.events.get(runId) ?? [])];
    for (const event of events) {
      const output =
        event.output === undefined
          ? null
          : await seal(
              keys,
              bindings.transcript({ field: 'tr.output', taskId, runId, seq: event.seq }),
              event.output,
            );
      stored.push({
        seq: event.seq,
        at: isoAt(-minutes(50) + event.seq * 1000),
        kind: event.kind,
        parent: event.parent ?? null,
        data: await seal(
          keys,
          bindings.transcript({ field: 'tr.data', taskId, runId, seq: event.seq }),
          JSON.stringify(event.data),
        ),
        output,
        outputSize: event.output === undefined ? null : event.output.length,
      });
    }
    this.events.set(runId, stored);
  }

  async seedTask(input: SeedTask): Promise<UiTaskListItem> {
    return this.seed(input);
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    const route = this.current.pathWithQuery;
    this.requests.push(`${method} ${route}`);
    const query = new URL(route, 'http://localhost').searchParams;
    if (method === 'GET' && path === getClientTaskRoute.path) {
      const task = this.tasks.find((candidate) => candidate.id === query.get('id'));
      if (task === undefined) {
        return json(404, { error: { code: 'not-found', message: 'no task' } });
      }
      return json(200, {
        task: taskOnly(task),
        thread: this.threads.get(task.id) ?? [],
        followUps: [],
        parent: null,
      });
    }
    if (method === 'GET' && path === listClientDirectoriesRoute.path) {
      const keys = await OWNER_KEYS;
      return json(200, {
        directories: await Promise.all(
          this.directories.map(async (directory) => ({
            id: directory.id,
            path: await seal(keys, bindings.directoryPath(directory.id), directory.path),
            repo: null,
            projectId: PROJECT_HOME,
          })),
        ),
      });
    }
    if (method === 'GET' && path === clientTranscriptRunsRoute.path) {
      const runs = this.runs.get(query.get('id') ?? '') ?? [];
      return json(200, {
        runs: runs.map((run) => ({
          ...run,
          sessionId: null,
          resumed: false,
          lastEventAt: run.startedAt,
          eventCount: this.events.get(run.id)?.length ?? 0,
        })),
      });
    }
    if (method === 'GET' && path === clientTranscriptEventsRoute.path) {
      const after = query.get('afterSeq');
      const list = (this.events.get(query.get('runId') ?? '') ?? []).filter(
        (event) => after === null || event.seq > Number(after),
      );
      return json(200, {
        events: list.map((event) => ({
          seq: event.seq,
          at: event.at,
          kind: event.kind,
          parent: event.parent,
          data: event.data,
          outputSize: event.outputSize,
        })),
      });
    }
    if (method === 'GET' && path === clientTranscriptOutputRoute.path) {
      const found = (this.events.get(query.get('runId') ?? '') ?? []).find(
        (event) => event.seq === Number(query.get('seq')),
      );
      return json(200, { output: found?.output ?? null });
    }
    if (method === 'POST') {
      const task = this.tasks.find((candidate) => candidate.id === body?.id);
      if (path === setPriorityClientTaskRoute.path && task !== undefined) {
        this.priorities.push(body ?? {});
        task.priority = body?.priority as UiTaskListItem['priority'];
        return json(200, taskOnly(task));
      }
      if (path === setProjectClientTaskRoute.path && task !== undefined) {
        this.projectChanges.push(body ?? {});
        task.projectId = String(body?.projectId);
        return json(200, taskOnly(task));
      }
      if (path === removePrClientTaskRoute.path && task !== undefined) {
        this.prRemovals.push(body ?? {});
        task.prs = task.prs.filter((pr) => pr.id !== body?.prId);
        return json(200, taskOnly(task));
      }
      if (path === stopWatchClientTaskRoute.path && task !== undefined) {
        this.watchStopped.push(body ?? {});
        task.watchStops = [...task.watchStops, String(body?.watchId)];
        return json(200, taskOnly(task));
      }
      if (path === configureClientTaskRoute.path && task !== undefined) {
        this.configures.push(body ?? {});
        if (typeof body?.title === 'string') task.title = body.title;
        if ('model' in (body ?? {})) task.model = (body?.model as string | null) ?? null;
        if ('effort' in (body ?? {}))
          task.effort = (body?.effort as UiTaskListItem['effort']) ?? null;
        if ('lane' in (body ?? {})) task.requestedLane = (body?.lane as string | null) ?? null;
        if (typeof body?.autoDone === 'boolean') task.autoDone = body.autoDone;
        if ('place' in (body ?? {})) {
          const place = body?.place as { directoryId: string } | null;
          task.directoryId = place === null ? null : place.directoryId;
        }
        return json(200, taskOnly(task));
      }
    }
    return super.answer(method, path, body);
  }
}
