import type { UiTaskListItem } from '@rumo/contract';
import { bindings, open, seal, type Binding, type Keys, type Origin } from '@rumo/sealing';

import { readContext, type ContextUsage } from './context-model.js';

export const UNREADABLE_TITLE = 'Unreadable task';

export interface BoardCard {
  readonly serverId?: string;
  readonly task: UiTaskListItem;
  readonly title: string;
  readonly icon: string | null;
  readonly labels: readonly string[];
  readonly note: string | null;
  readonly watches: number;
  readonly context: ContextUsage | null;
}

export interface InputShape {
  readonly forkOf: string | null;
  readonly agent: string | null;
  readonly directoryId: string | null;
}

export interface OpenedPrompt {
  readonly text: string;
  readonly shape: InputShape;
}

export const cardUid = (card: BoardCard): string =>
  card.serverId === undefined ? card.task.id : `${card.serverId}:${card.task.id}`;

export const attempt = async (
  keys: Keys,
  binding: Binding,
  envelope: string | null | undefined,
): Promise<string | null> => {
  if (envelope === null || envelope === undefined) return null;
  try {
    return await open(keys, binding, envelope);
  } catch {
    return null;
  }
};

interface TaskRef {
  readonly id: string;
  readonly scheduleId?: string | null;
}

const originsOf = (task: TaskRef): readonly Origin[] =>
  task.scheduleId === null || task.scheduleId === undefined
    ? [{ task: task.id }]
    : [{ task: task.id }, { schedule: task.scheduleId }];

export const attemptTaskField = async (
  keys: Keys,
  field: 'title' | 'icon' | 'labels' | 'agent',
  task: TaskRef,
  envelope: string | null | undefined,
): Promise<string | null> => {
  for (const origin of originsOf(task)) {
    const text = await attempt(keys, bindings[field](origin), envelope);
    if (text !== null) return text;
  }
  return null;
};

export function parseLabels(text: string | null): readonly string[] {
  if (text === null || text.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed))
      return parsed.filter((label): label is string => typeof label === 'string' && label !== '');
  } catch {
    return text
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');
  }
  return [];
}

export const serializeLabels = (labels: readonly string[]): string => JSON.stringify(labels);

function countWatches(text: string | null): number {
  if (text === null || text.trim() === '') return 0;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.length : 1;
  } catch {
    return 1;
  }
}

export async function decryptCard(
  keys: Keys,
  task: UiTaskListItem,
  withContext = false,
): Promise<BoardCard> {
  const author = task.lastNote?.author;
  const [title, icon, labels, watches, note, context] = await Promise.all([
    attemptTaskField(keys, 'title', task, task.title),
    attemptTaskField(keys, 'icon', task, task.icon),
    attemptTaskField(keys, 'labels', task, task.labels),
    attempt(keys, bindings.watches(task.id), task.watches),
    task.lastNote === null || author === undefined || author === 'server'
      ? Promise.resolve(null)
      : attempt(
          keys,
          bindings.note({
            field: 'note.preview',
            taskId: task.id,
            author,
            kind: task.lastNote.kind,
          }),
          task.lastNote.preview,
        ),
    withContext && task.status === 'running'
      ? readContext(keys, task.id, task.context)
      : Promise.resolve(null),
  ]);
  return {
    task,
    title: title ?? UNREADABLE_TITLE,
    icon: icon === null || icon === '' ? null : icon,
    labels: parseLabels(labels),
    note,
    watches: countWatches(watches),
    context,
  };
}

export const inputBinding = (
  origin: Origin,
  creator: 'user' | 'agent' | 'intake',
  shape: InputShape,
): Binding =>
  bindings.input({
    origin,
    creator,
    forkOf: shape.forkOf,
    agent: shape.agent,
    directoryId: shape.directoryId,
  });

export async function openPrompt(
  keys: Keys,
  task: Pick<
    UiTaskListItem,
    'id' | 'input' | 'createdBy' | 'directoryId' | 'agent' | 'forkOf' | 'scheduleId'
  >,
): Promise<OpenedPrompt | null> {
  const agent = await attemptTaskField(keys, 'agent', task, task.agent);
  const directories = task.directoryId === null ? [null] : [task.directoryId, null];
  const agents = agent === null ? [null] : [agent, null];
  for (const origin of originsOf(task)) {
    for (const directoryId of directories) {
      for (const agentName of agents) {
        const shape: InputShape = { forkOf: task.forkOf ?? null, agent: agentName, directoryId };
        const binding = inputBinding(origin, task.createdBy, shape);
        const text = await attempt(keys, binding, task.input);
        if (text !== null) return { text, shape };
      }
    }
  }
  return null;
}

export const sealPromptAsUser = (
  keys: Keys,
  taskId: string,
  shape: InputShape,
  text: string,
): Promise<string> => seal(keys, inputBinding({ task: taskId }, 'user', shape), text);

export const sealIcon = (keys: Keys, taskId: string, icon: string): Promise<string> =>
  seal(keys, bindings.icon({ task: taskId }), icon);

export const sealLabels = (
  keys: Keys,
  taskId: string,
  labels: readonly string[],
): Promise<string> => seal(keys, bindings.labels({ task: taskId }), serializeLabels(labels));
