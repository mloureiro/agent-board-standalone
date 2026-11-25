import type { UiTask } from '@agent-board/contract';

import { parseTime } from '../board/format.js';
import { parseQuestions, type Question } from './question-model.js';
import type { TaskView, ThreadEntry } from './task-model.js';

export const TAKE_BACK_AFTER_MS = 20 * 60_000;

export type PanelKind = 'closed' | 'running' | 'backlog' | 'todo' | 'reply';

export interface OpenQuestion {
  readonly noteId: string;
  readonly source: string;
  readonly questions: readonly Question[] | null;
}

export interface PolishRewrite {
  readonly target: string;
  readonly title: string;
  readonly prompt: string;
}

export type PolishState =
  | { readonly usable: true; readonly rewrite: PolishRewrite }
  | { readonly usable: false; readonly reason: string };

const APPLIES_IN: readonly string[] = ['backlog', 'needs-me'];

export const isProposal = (task: UiTask): boolean => task.createdBy === 'agent';

export function panelKind(task: UiTask): PanelKind {
  if (task.closed) return 'closed';
  if (task.status === 'running') return 'running';
  if (task.status === 'backlog') return 'backlog';
  if (task.status === 'todo') return 'todo';
  return 'reply';
}

export function canEditPrompt(view: TaskView): boolean {
  const { task } = view;
  return (
    task.createdBy === 'user' &&
    !task.started &&
    !task.closed &&
    (task.status === 'todo' || task.status === 'backlog') &&
    view.prompt !== null &&
    view.promptShape !== null
  );
}

export function canFork(view: TaskView, features: readonly string[]): boolean {
  return (
    features.includes('forks') &&
    view.task.sessionId !== null &&
    view.promptShape !== null &&
    !isProposal(view.task)
  );
}

export function canTakeBack(task: UiTask, now: number): boolean {
  const last = parseTime(task.lastActiveAt);
  return task.status === 'running' && last !== null && now - last >= TAKE_BACK_AFTER_MS;
}

export function openQuestionOf(view: TaskView): OpenQuestion | null {
  if (!view.task.openQuestion || view.task.closed || isProposal(view.task)) return null;
  const asked = view.thread
    .filter((entry) => entry.note.kind === 'question' && entry.note.author !== 'server')
    .at(-1);
  if (asked === undefined) return null;
  const source = asked.questions;
  return {
    noteId: asked.note.id,
    source: source ?? '',
    questions: source === null ? null : parseQuestions(source),
  };
}

export function currentSuggestion(view: TaskView): string | null {
  if (view.task.status !== 'needs-me' || isProposal(view.task)) return null;
  const at = view.thread.findLastIndex(
    (entry) => entry.note.author === 'agent' && entry.note.kind === 'comment',
  );
  const suggestion = view.thread[at]?.suggestion ?? null;
  if (suggestion === null || suggestion.trim() === '') return null;
  const moved = view.thread.slice(at + 1).some((entry) => entry.note.author === 'user');
  return moved ? null : suggestion;
}

export function parsePolish(body: string | null): PolishRewrite | null {
  if (body === null) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object') return null;
    const { target, title, prompt } = parsed as Record<string, unknown>;
    if (
      typeof target !== 'string' ||
      typeof title !== 'string' ||
      typeof prompt !== 'string' ||
      title.trim() === '' ||
      prompt.trim() === ''
    ) {
      return null;
    }
    return { target, title, prompt };
  } catch {
    return null;
  }
}

export function polishState(view: TaskView, entry: ThreadEntry): PolishState {
  const rewrite = parsePolish(entry.body);
  if (entry.note.author !== 'agent' || rewrite === null) {
    return { usable: false, reason: 'This is not a polished prompt this browser understands.' };
  }
  const parent = view.parentTask;
  if (parent === null || view.parentPrompt === null) {
    return { usable: false, reason: 'This task has no readable parent to apply it to.' };
  }
  if (rewrite.target !== parent.id) {
    return {
      usable: false,
      reason: `It is for task ${rewrite.target}, not for this task's parent.`,
    };
  }
  if (parent.closed || !APPLIES_IN.includes(parent.status)) {
    return { usable: false, reason: 'The parent task is no longer in Backlog or Needs me.' };
  }
  if (parent.createdBy !== 'user' || parent.scheduleId !== null) {
    return {
      usable: false,
      reason: 'The parent is not a task you wrote, so a prompt cannot be applied to it.',
    };
  }
  return { usable: true, rewrite };
}

export const oneLine = (text: string, limit: number): string => {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};
