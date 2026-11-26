import type { WireNote, WireTask } from '@agent-board/contract';
import { bindings, open, type Binding, type Keys, type Origin } from '@agent-board/sealing';

export const UNREADABLE_TEXT = '(cannot decrypt)';

export type Unreadable = 'title' | 'input' | 'agent' | 'icon' | 'labels' | 'pr' | 'watches';

export interface OpenPr {
  readonly id: string;
  readonly url: string | null;
  readonly state: string | null;
}

export interface OpenTask {
  readonly wire: WireTask;
  readonly id: string;
  readonly title: string | null;
  readonly input: string | null;
  readonly agent: string | null;
  readonly icon: string | null;
  readonly labels: readonly string[];
  readonly prs: readonly OpenPr[];
  readonly unreadable: readonly Unreadable[];
}

export interface OpenNote {
  readonly id: string;
  readonly author: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly text: string | null;
  readonly questions: string | null;
  readonly answers: string | null;
  readonly questionNoteId: string | null;
  readonly suggestion: string | null;
  readonly unreadable: boolean;
}

async function attempt(keys: Keys, binding: Binding, envelope: string): Promise<string | null> {
  try {
    return await open(keys, binding, envelope);
  } catch {
    return null;
  }
}

function labelsOf(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}

export function inputBinding(
  wire: WireTask,
  agent: string | null,
  origin: 'task' | 'schedule',
  withDirectory = true,
): Binding {
  return bindings.input({
    origin:
      origin === 'task' || wire.scheduleId === null
        ? { task: wire.id }
        : { schedule: wire.scheduleId },
    creator: wire.createdBy,
    forkOf: wire.forkOf ?? null,
    agent,
    directoryId: withDirectory ? wire.directoryId : null,
  });
}

async function attemptTaskField(
  keys: Keys,
  field: 'title' | 'agent' | 'icon' | 'labels',
  wire: WireTask,
  envelope: string,
): Promise<string | null> {
  const origins: Origin[] =
    wire.scheduleId === null
      ? [{ task: wire.id }]
      : [{ task: wire.id }, { schedule: wire.scheduleId }];
  for (const origin of origins) {
    const text = await attempt(keys, bindings[field](origin), envelope);
    if (text !== null) return text;
  }
  return null;
}

export async function openTask(keys: Keys, wire: WireTask): Promise<OpenTask> {
  const unreadable: Unreadable[] = [];
  const track = (field: Unreadable, value: string | null, present: boolean): string | null => {
    if (present && value === null) unreadable.push(field);
    return value;
  };

  const title = track('title', await attemptTaskField(keys, 'title', wire, wire.title), true);
  const agent =
    wire.agent === null || wire.agent === undefined
      ? null
      : track('agent', await attemptTaskField(keys, 'agent', wire, wire.agent), true);
  let input = await attempt(keys, inputBinding(wire, agent, 'task'), wire.input);
  if (input === null && wire.scheduleId !== null) {
    input = await attempt(keys, inputBinding(wire, agent, 'schedule'), wire.input);
  }
  if (input === null && wire.directoryId !== null) {
    input = await attempt(keys, inputBinding(wire, agent, 'task', false), wire.input);
    if (input === null && wire.scheduleId !== null) {
      input = await attempt(keys, inputBinding(wire, agent, 'schedule', false), wire.input);
    }
  }
  track('input', input, true);
  const icon =
    wire.icon === null
      ? null
      : track('icon', await attemptTaskField(keys, 'icon', wire, wire.icon), true);
  let labels: string[] = [];
  if (wire.labels !== null) {
    const text = await attemptTaskField(keys, 'labels', wire, wire.labels);
    const parsed = text === null ? null : labelsOf(text);
    if (parsed === null) unreadable.push('labels');
    else labels = parsed;
  }
  const prs = await Promise.all(
    wire.prs.map(async (pr): Promise<OpenPr> => {
      const url = await attempt(keys, bindings.pr(wire.id), pr.pr);
      if (url === null) unreadable.push('pr');
      return { id: pr.id, url, state: pr.state };
    }),
  );
  return { wire, id: wire.id, title, input, agent, icon, labels, prs, unreadable };
}

export async function openNote(keys: Keys, taskId: string, wire: WireNote): Promise<OpenNote> {
  const base = {
    id: wire.id,
    author: wire.author,
    kind: wire.kind,
    createdAt: wire.createdAt,
    questionNoteId: wire.questionNoteId ?? null,
  };
  if (wire.author === 'server') {
    return {
      ...base,
      text: wire.body,
      questions: null,
      answers: null,
      suggestion: null,
      unreadable: false,
    };
  }
  const binding = (field: 'note.body' | 'note.questions' | 'note.answers' | 'note.suggestion') =>
    bindings.note({ field, taskId, author: wire.author, kind: wire.kind });
  const text = await attempt(keys, binding('note.body'), wire.body);
  const questions =
    wire.questions === undefined
      ? null
      : await attempt(keys, binding('note.questions'), wire.questions);
  const answers =
    wire.answers === undefined ? null : await attempt(keys, binding('note.answers'), wire.answers);
  const suggestion =
    wire.suggestion === undefined
      ? null
      : await attempt(keys, binding('note.suggestion'), wire.suggestion);
  return { ...base, text, questions, answers, suggestion, unreadable: text === null };
}

const SEALED_KEYS = new Set([
  'title',
  'input',
  'agent',
  'icon',
  'labels',
  'prs',
  'watches',
  'legacyDirectory',
]);

export function taskJson(task: OpenTask): Record<string, unknown> {
  const rest = Object.fromEntries(
    Object.entries(task.wire).filter(([key]) => !SEALED_KEYS.has(key)),
  );
  return {
    ...rest,
    title: task.title,
    input: task.input,
    agent: task.agent,
    icon: task.icon,
    labels: task.labels,
    prs: task.prs,
    unreadable: task.unreadable,
  };
}

export function noteJson(note: OpenNote): Record<string, unknown> {
  return {
    id: note.id,
    author: note.author,
    kind: note.kind,
    createdAt: note.createdAt,
    text: note.text,
    ...(note.questions === null ? {} : { questions: note.questions }),
    ...(note.answers === null ? {} : { answers: note.answers }),
    ...(note.suggestion === null ? {} : { suggestion: note.suggestion }),
    unreadable: note.unreadable,
  };
}
