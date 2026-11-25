import type { UiTaskListItem } from '@agent-board/contract';
import { bindings, open, seal, type Binding, type Keys } from '@agent-board/sealing';

export const UNREADABLE_TITLE = 'Unreadable task';

export interface BoardCard {
  readonly task: UiTaskListItem;
  readonly title: string;
  readonly icon: string | null;
  readonly labels: readonly string[];
  readonly note: string | null;
  readonly watches: number;
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

const attempt = async (
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

export async function decryptCard(keys: Keys, task: UiTaskListItem): Promise<BoardCard> {
  const author = task.lastNote?.author;
  const [title, icon, labels, watches, note] = await Promise.all([
    attempt(keys, bindings.title({ task: task.id }), task.title),
    attempt(keys, bindings.icon({ task: task.id }), task.icon),
    attempt(keys, bindings.labels({ task: task.id }), task.labels),
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
  ]);
  return {
    task,
    title: title ?? UNREADABLE_TITLE,
    icon: icon === null || icon === '' ? null : icon,
    labels: parseLabels(labels),
    note,
    watches: countWatches(watches),
  };
}

export const inputBinding = (
  taskId: string,
  creator: 'user' | 'agent' | 'intake',
  shape: InputShape,
): Binding =>
  bindings.input({
    origin: { task: taskId },
    creator,
    forkOf: shape.forkOf,
    agent: shape.agent,
    directoryId: shape.directoryId,
  });

export async function openPrompt(
  keys: Keys,
  task: Pick<UiTaskListItem, 'id' | 'input' | 'createdBy' | 'directoryId' | 'agent' | 'forkOf'>,
): Promise<OpenedPrompt | null> {
  const agent = await attempt(keys, bindings.agent({ task: task.id }), task.agent);
  const directories = task.directoryId === null ? [null] : [task.directoryId, null];
  const agents = agent === null ? [null] : [agent, null];
  for (const directoryId of directories) {
    for (const agentName of agents) {
      const shape: InputShape = { forkOf: task.forkOf ?? null, agent: agentName, directoryId };
      const text = await attempt(keys, inputBinding(task.id, task.createdBy, shape), task.input);
      if (text !== null) return { text, shape };
    }
  }
  return null;
}

export const sealPromptAsUser = (
  keys: Keys,
  taskId: string,
  shape: InputShape,
  text: string,
): Promise<string> => seal(keys, inputBinding(taskId, 'user', shape), text);

export const sealIcon = (keys: Keys, taskId: string, icon: string): Promise<string> =>
  seal(keys, bindings.icon({ task: taskId }), icon);

export const sealLabels = (
  keys: Keys,
  taskId: string,
  labels: readonly string[],
): Promise<string> => seal(keys, bindings.labels({ task: taskId }), serializeLabels(labels));
