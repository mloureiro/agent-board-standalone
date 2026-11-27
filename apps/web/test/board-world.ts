import {
  configureClientTaskRoute,
  doneClientTaskRoute,
  listClientMachinesRoute,
  listClientProjectsRoute,
  listClientTasksRoute,
  moveClientTaskRoute,
  clientEventsRoute,
  type TaskStatus,
  type UiTaskListItem,
} from '@rumo/contract';
import { bindings, deriveKeys, seal, type Keys } from '@rumo/sealing';

import type { ConnectionCheck } from '../src/servers/index.js';
import { FakeBoard, json } from './fake-board.js';
import { serverVersion } from './versions.js';

export const FROZEN_NOW = Date.parse('2026-11-25T12:00:00.000Z');
export const frozenClock = (): number => FROZEN_NOW;
export const OWNER_KEYS: Promise<Keys> = deriveKeys(new Uint8Array(32), 'owner');

const at = (offsetMs: number): string => new Date(FROZEN_NOW + offsetMs).toISOString();
export const minutes = (count: number): number => count * 60_000;
export const hours = (count: number): number => count * 3_600_000;
export const isoAt = at;

export interface SeedTask {
  readonly id: string;
  readonly title: string;
  readonly status?: TaskStatus;
  readonly icon?: string;
  readonly labels?: readonly string[];
  readonly note?: string;
  readonly prompt?: string;
  readonly watches?: readonly string[];
  readonly overrides?: Partial<Omit<UiTaskListItem, 'title' | 'input' | 'icon' | 'labels'>>;
}

const wireOf = (task: UiTaskListItem) =>
  Object.fromEntries(
    Object.entries(task).filter(([key]) => key !== 'lastNote' && key !== 'context'),
  );

const base = (id: string, status: TaskStatus): Omit<UiTaskListItem, 'title' | 'input'> => ({
  id,
  status,
  createdBy: 'user',
  priority: 'normal',
  model: null,
  effort: null,
  requestedLane: null,
  autoDone: false,
  icon: null,
  labels: null,
  closed: false,
  machine: null,
  sessionId: null,
  projectId: '11111111-1111-4111-8111-111111111111',
  directoryId: null,
  legacyDirectory: null,
  next: 'fresh',
  head: null,
  openQuestion: false,
  lane: null,
  borrowed: false,
  lastActiveAt: null,
  runStartedAt: null,
  paused: false,
  notBefore: null,
  scheduleId: null,
  wakeAt: null,
  waitCheck: false,
  woken: false,
  prs: [],
  promptPrState: null,
  watches: null,
  watchStops: [],
  proposed: false,
  started: false,
  parentId: null,
  createdAt: at(-hours(2)),
  updatedAt: at(-hours(1)),
  lastNote: null,
  context: null,
});

export interface WorldMachine {
  name: string;
  clientStatus: 'unknown' | 'incompatible' | 'outdated' | 'current';
  usage?: string | null;
  revokedAt?: string | null;
}

export class BoardWorld extends FakeBoard {
  tasks: UiTaskListItem[] = [];
  machines: WorldMachine[] = [];
  projects: { id: string; name: string }[] = [];
  features: string[] = [];
  listStatus = 200;
  eventsStatus = 200;
  eventStreamsOpened = 0;
  readonly moves: Record<string, unknown>[] = [];
  readonly configures: Record<string, unknown>[] = [];
  readonly doneIds: string[] = [];
  readonly listQueries: string[] = [];
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private readonly encoder = new TextEncoder();

  override readonly check: ConnectionCheck = async () => ({
    state: 'up',
    server: serverVersion({ session: 'not-required', features: this.features }),
  });

  async seed(input: SeedTask): Promise<UiTaskListItem> {
    const keys = await OWNER_KEYS;
    const status = input.status ?? 'backlog';
    const task: UiTaskListItem = {
      ...base(input.id, status),
      title: await seal(keys, bindings.title({ task: input.id }), input.title),
      input: await seal(
        keys,
        bindings.input({
          origin: { task: input.id },
          creator: input.overrides?.createdBy ?? 'user',
        }),
        input.prompt ?? input.title,
      ),
      icon:
        input.icon === undefined
          ? null
          : await seal(keys, bindings.icon({ task: input.id }), input.icon),
      labels:
        input.labels === undefined
          ? null
          : await seal(keys, bindings.labels({ task: input.id }), JSON.stringify(input.labels)),
      watches:
        input.watches === undefined
          ? null
          : await seal(keys, bindings.watches(input.id), JSON.stringify(input.watches)),
      ...input.overrides,
    };
    if (input.note !== undefined) {
      task.lastNote = {
        createdAt: at(-minutes(5)),
        author: 'agent',
        kind: 'comment',
        preview: await seal(
          keys,
          bindings.note({
            field: 'note.preview',
            taskId: input.id,
            author: 'agent',
            kind: 'comment',
          }),
          input.note,
        ),
      };
    }
    this.tasks.push(task);
    return task;
  }

  idsIn(status: TaskStatus): string[] {
    return this.tasks.filter((task) => task.status === status).map((task) => task.id);
  }

  push(event: string): void {
    for (const controller of this.streams) {
      controller.enqueue(this.encoder.encode(`event: ${event}\ndata: {}\n\n`));
    }
  }

  protected override answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Response | Promise<Response> {
    if (method === 'GET' && path === clientEventsRoute.path) {
      if (this.eventsStatus !== 200)
        return json(this.eventsStatus, { error: { code: 'x', message: 'down' } });
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.eventStreamsOpened += 1;
          this.streams.push(controller);
          controller.enqueue(this.encoder.encode(': open\n\n'));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (method === 'GET' && path === listClientTasksRoute.path) {
      this.listQueries.push(this.current.pathWithQuery);
      const lean =
        new URL(this.current.pathWithQuery, 'http://localhost').searchParams.get('withoutInput') ===
        'true';
      const withoutInput = (task: UiTaskListItem): UiTaskListItem => {
        const copy = { ...task };
        delete copy.input;
        return copy;
      };
      return this.listStatus === 200
        ? json(200, { tasks: lean ? this.tasks.map(withoutInput) : this.tasks })
        : json(this.listStatus, { error: { code: 'unavailable', message: 'down' } });
    }
    if (method === 'GET' && path === listClientMachinesRoute.path) {
      return json(200, {
        machines: this.machines.map((machine) => ({
          name: machine.name,
          createdAt: at(-hours(48)),
          lastSeenAt: null,
          revokedAt: machine.revokedAt ?? null,
          clientVersion: null,
          clientStatus: machine.clientStatus,
          usage: machine.usage ?? null,
          usageUpdatedAt: null,
          grant: false,
        })),
      });
    }
    if (method === 'GET' && path === listClientProjectsRoute.path) {
      return this.projectsAnswer();
    }
    if (method === 'POST' && path === moveClientTaskRoute.path) return this.move(body ?? {});
    if (method === 'POST' && path === configureClientTaskRoute.path) {
      this.configures.push(body ?? {});
      const task = this.tasks.find((candidate) => candidate.id === body?.id);
      if (task === undefined)
        return json(404, { error: { code: 'not-found', message: 'no task' } });
      if ('icon' in (body ?? {})) task.icon = (body?.icon as string | null) ?? null;
      if ('labels' in (body ?? {})) task.labels = (body?.labels as string | null) ?? null;
      return json(200, wireOf(task));
    }
    if (method === 'POST' && path === doneClientTaskRoute.path) {
      this.doneIds.push(String(body?.id));
      const task = this.tasks.find((candidate) => candidate.id === body?.id);
      if (task === undefined)
        return json(404, { error: { code: 'not-found', message: 'no task' } });
      task.status = 'done';
      return json(200, wireOf(task));
    }
    return super.answer(method, path, body);
  }

  private async projectsAnswer(): Promise<Response> {
    const keys = await OWNER_KEYS;
    return json(200, {
      projects: await Promise.all(
        this.projects.map(async (project, position) => ({
          id: project.id,
          name: await seal(keys, bindings.projectName(project.id), project.name),
          icon: null,
          position,
          isDefault: position === 0,
          archivedAt: null,
          createdAt: at(-hours(100)),
          updatedAt: at(-hours(100)),
        })),
      ),
    });
  }

  private move(body: Record<string, unknown>): Response {
    this.moves.push(body);
    const index = this.tasks.findIndex((candidate) => candidate.id === body.id);
    const moving = this.tasks[index];
    if (moving === undefined)
      return json(404, { error: { code: 'not-found', message: 'no task' } });
    if (typeof body.startInput === 'string') moving.input = body.startInput;
    moving.status = body.status as TaskStatus;
    this.tasks.splice(index, 1);
    const anchorId = (body.beforeId ?? body.afterId) as string | undefined;
    const anchor = this.tasks.findIndex((candidate) => candidate.id === anchorId);
    if (anchor < 0) this.tasks.push(moving);
    else this.tasks.splice(body.beforeId === undefined ? anchor + 1 : anchor, 0, moving);
    return json(200, wireOf(moving));
  }
}
