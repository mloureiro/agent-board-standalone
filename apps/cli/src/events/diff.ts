import type { TaskActor, TaskStatus } from '@rumo/contract';

import type { OpenNote, OpenTask } from '../commands/tasks/open.js';

export const EVENT_TYPES = ['created', 'moved', 'changed', 'closed', 'removed', 'note'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const WATCHED_FIELDS = [
  'title',
  'priority',
  'model',
  'agent',
  'machine',
  'openQuestion',
  'notBefore',
  'wakeAt',
  'prs',
  'promptPrState',
] as const;
export type WatchedField = (typeof WATCHED_FIELDS)[number];

export interface BoardEvent {
  readonly type: EventType;
  readonly at: Date;
  readonly task: OpenTask;
  readonly status: TaskStatus;
  readonly from?: TaskStatus;
  readonly to?: TaskStatus;
  readonly actor?: TaskActor;
  readonly fields?: readonly WatchedField[];
  readonly note?: OpenNote;
}

export interface DiffDeps {
  readNotes(id: string): Promise<OpenNote[]>;
  fetchLeft(id: string): Promise<OpenTask | null>;
  readonly at: Date;
}

const watched: Record<WatchedField, (task: OpenTask) => unknown> = {
  title: (task) => task.title,
  priority: (task) => task.wire.priority,
  model: (task) => task.wire.model,
  agent: (task) => task.agent,
  machine: (task) => task.wire.machine,
  openQuestion: (task) => task.wire.openQuestion,
  notBefore: (task) => task.wire.notBefore,
  wakeAt: (task) => task.wire.wakeAt,
  prs: (task) => task.prs.map(({ id, url, state }) => [id, url, state]),
  promptPrState: (task) => task.wire.promptPrState,
};

export function changedFields(before: OpenTask, after: OpenTask): WatchedField[] {
  return WATCHED_FIELDS.filter(
    (field) => JSON.stringify(watched[field](before)) !== JSON.stringify(watched[field](after)),
  );
}

async function newNotes(
  task: OpenTask,
  before: OpenTask | undefined,
  readNotes: DiffDeps['readNotes'],
): Promise<OpenNote[]> {
  const count = task.wire.noteCount;
  const known = before?.wire.noteCount;
  if (count === undefined || known === undefined || count <= known) return [];
  return (await readNotes(task.id)).slice(known, count);
}

async function leftTask(last: OpenTask, deps: DiffDeps): Promise<BoardEvent | undefined> {
  const task = await deps.fetchLeft(last.id);
  if (task === null) return { type: 'removed', at: deps.at, task: last, status: last.wire.status };
  return task.wire.closed
    ? { type: 'closed', at: deps.at, task, status: last.wire.status }
    : undefined;
}

export async function diffTasks(
  previous: readonly OpenTask[],
  current: readonly OpenTask[],
  deps: DiffDeps,
): Promise<BoardEvent[]> {
  const before = new Map(previous.map((task) => [task.id, task]));
  const open = new Set(current.map((task) => task.id));
  const perTask = await Promise.all(
    current.map(async (task): Promise<BoardEvent[]> => {
      const last = before.get(task.id);
      const notes = await newNotes(task, last, deps.readNotes);
      const base = { at: deps.at, task, status: task.wire.status };
      const fields = last === undefined ? [] : changedFields(last, task);
      return [
        ...(last === undefined ? [{ ...base, type: 'created' as const }] : []),
        ...notes.map((note) => ({ ...base, type: 'note' as const, note })),
        ...(last !== undefined && last.wire.status !== task.wire.status
          ? [
              {
                ...base,
                type: 'moved' as const,
                from: last.wire.status,
                to: task.wire.status,
                ...(task.wire.movedBy === undefined ? {} : { actor: task.wire.movedBy }),
              },
            ]
          : []),
        ...(fields.length === 0 ? [] : [{ ...base, type: 'changed' as const, fields }]),
      ];
    }),
  );
  const left = await Promise.all(
    previous.filter((task) => !open.has(task.id)).map((task) => leftTask(task, deps)),
  );
  return [...perTask.flat(), ...left.filter((event) => event !== undefined)];
}

export interface EventFilter {
  readonly tasks: readonly string[];
  readonly statuses: readonly TaskStatus[];
  readonly types: readonly EventType[];
  readonly actors: readonly TaskActor[];
  readonly machine?: string;
  readonly project?: string;
}

export function matchesFilter(event: BoardEvent, filter: EventFilter): boolean {
  return (
    (filter.tasks.length === 0 || filter.tasks.includes(event.task.id)) &&
    (filter.statuses.length === 0 || filter.statuses.includes(event.status)) &&
    (filter.types.length === 0 || filter.types.includes(event.type)) &&
    (filter.actors.length === 0 ||
      (event.type === 'moved' &&
        event.actor !== undefined &&
        filter.actors.includes(event.actor))) &&
    (filter.machine === undefined || event.task.wire.machine === filter.machine) &&
    (filter.project === undefined || event.task.wire.projectId === filter.project)
  );
}
