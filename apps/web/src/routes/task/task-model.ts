import type { PrState, UiTask, UiTaskDetail, UiThreadNote } from '@agent-board/contract';
import { bindings, type Keys } from '@agent-board/sealing';

import { attempt, openPrompt, parseLabels, UNREADABLE_TITLE } from '../board/card-model.js';

export interface TaskPr {
  readonly id: string;
  readonly label: string;
  readonly url: string | null;
  readonly state: PrState | null;
}

export interface TaskWatch {
  readonly id: string | null;
  readonly text: string;
  readonly stopping: boolean;
}

export interface ThreadEntry {
  readonly note: UiThreadNote;
  readonly body: string | null;
  readonly questions: string | null;
  readonly answers: string | null;
}

export interface RelatedTask {
  readonly id: string;
  readonly title: string;
}

export interface TaskView {
  readonly task: UiTask;
  readonly title: string;
  readonly icon: string | null;
  readonly labels: readonly string[];
  readonly prompt: string | null;
  readonly legacyDirectory: string | null;
  readonly prs: readonly TaskPr[];
  readonly watches: readonly TaskWatch[];
  readonly thread: readonly ThreadEntry[];
  readonly followUps: readonly RelatedTask[];
  readonly parent: RelatedTask | null;
  readonly alerts: readonly string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value))
    return value
      .map(describeValue)
      .filter((line) => line !== '')
      .join('\n');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${describeValue(entry)}`)
      .join('\n');
  }
  return String(value);
}

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
};

const httpUrl = (value: string | null): string | null =>
  value !== null && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;

export function parsePr(source: string): { label: string; url: string | null } {
  const parsed = parseJson(source);
  if (typeof parsed === 'object' && parsed !== null) {
    const body = record(parsed);
    const given = text(body.url) ?? text(body.link);
    const label = text(body.title) ?? text(body.label) ?? given ?? source;
    return { label, url: httpUrl(given) };
  }
  const trimmed = source.trim();
  return { label: trimmed, url: httpUrl(trimmed) };
}

export function parseWatches(
  source: string,
): readonly { id: string | null; text: string }[] | null {
  const parsed = parseJson(source);
  if (!Array.isArray(parsed)) return null;
  return parsed.map((entry: unknown) => {
    if (typeof entry === 'string') return { id: null, text: entry };
    const body = record(entry);
    const label =
      text(body.description) ??
      text(body.text) ??
      text(body.summary) ??
      text(body.title) ??
      text(body.label) ??
      JSON.stringify(entry);
    return { id: text(body.id), text: label };
  });
}

async function relatedOf(keys: Keys, task: UiTask): Promise<RelatedTask> {
  const title = await attempt(keys, bindings.title({ task: task.id }), task.title);
  return { id: task.id, title: title ?? UNREADABLE_TITLE };
}

async function entryOf(keys: Keys, taskId: string, note: UiThreadNote): Promise<ThreadEntry> {
  if (note.author === 'server') {
    return { note, body: note.body, questions: null, answers: null };
  }
  const binding = (field: 'note.body' | 'note.questions' | 'note.answers') =>
    bindings.note({ field, taskId, author: note.author, kind: note.kind });
  const [body, questions, answers] = await Promise.all([
    attempt(keys, binding('note.body'), note.body),
    attempt(keys, binding('note.questions'), note.questions),
    attempt(keys, binding('note.answers'), note.answers),
  ]);
  return { note, body, questions, answers };
}

export async function decryptTask(keys: Keys, detail: UiTaskDetail): Promise<TaskView> {
  const { task } = detail;
  const [
    title,
    icon,
    labels,
    prompt,
    legacyDirectory,
    prTexts,
    watchText,
    thread,
    followUps,
    parent,
  ] = await Promise.all([
    attempt(keys, bindings.title({ task: task.id }), task.title),
    attempt(keys, bindings.icon({ task: task.id }), task.icon),
    attempt(keys, bindings.labels({ task: task.id }), task.labels),
    openPrompt(keys, task),
    attempt(keys, bindings.workdir({ task: task.id }), task.legacyDirectory),
    Promise.all(task.prs.map((pr) => attempt(keys, bindings.pr(task.id), pr.pr))),
    attempt(keys, bindings.watches(task.id), task.watches),
    Promise.all(detail.thread.map((note) => entryOf(keys, task.id, note))),
    Promise.all(detail.followUps.map((followUp) => relatedOf(keys, followUp))),
    detail.parent === null ? Promise.resolve(null) : relatedOf(keys, detail.parent),
  ]);

  const alerts: string[] = [];
  if (title === null) alerts.push('The title could not be read.');
  if (task.icon !== null && icon === null) alerts.push('The icon could not be read.');
  if (task.labels !== null && labels === null) alerts.push('The labels could not be read.');
  if (prompt === null) alerts.push('The prompt could not be read.');
  if (task.legacyDirectory !== null && legacyDirectory === null) {
    alerts.push('The working directory could not be read.');
  }

  const prs = task.prs.map((pr, index): TaskPr => {
    const source = prTexts[index] ?? null;
    if (source === null) {
      alerts.push('A pull request could not be read.');
      return { id: pr.id, label: 'Unreadable pull request', url: null, state: pr.state };
    }
    return { id: pr.id, ...parsePr(source), state: pr.state };
  });

  let watches: TaskWatch[] = [];
  if (task.watches !== null) {
    const parsed = watchText === null ? null : parseWatches(watchText);
    if (parsed === null) alerts.push('The watches could not be read.');
    else {
      watches = parsed.map((watch) => ({
        ...watch,
        stopping: watch.id !== null && task.watchStops.includes(watch.id),
      }));
    }
  }

  for (const entry of thread) {
    if (entry.body === null) {
      alerts.push('A note in the thread could not be read.');
      break;
    }
  }

  return {
    task,
    title: title ?? UNREADABLE_TITLE,
    icon: icon === null || icon === '' ? null : icon,
    labels: parseLabels(labels),
    prompt: prompt?.text ?? null,
    legacyDirectory,
    prs,
    watches,
    thread,
    followUps,
    parent,
    alerts,
  };
}
