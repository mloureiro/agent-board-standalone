import { TASK_STATUSES, listTasksRoute, projectId, readNotesRoute } from '@rumo/contract';

import { UsageError } from '../../errors.js';
import { parseStatus, plain } from '../../domain/rules.js';
import { localTime } from '../../domain/time.js';
import { formatAnswers, formatQuestions, questionsOf, answersOf } from '../../domain/questions.js';
import type { Context } from '../context.js';
import {
  UNREADABLE_TEXT,
  noteJson,
  openNote,
  openTask,
  taskJson,
  type OpenNote,
  type OpenTask,
} from './open.js';
import { fetchTask, resolveTask, session } from './support.js';

export interface TasksOptions {
  readonly all?: boolean;
  readonly status?: string;
  readonly project?: string;
  readonly json?: boolean;
}

export function checkedProject(value: string): string {
  if (!projectId.safeParse(value).success) {
    throw new UsageError(`"${value.slice(0, 40)}" is not a project id`);
  }
  return value;
}

export function formatTasks(found: readonly OpenTask[], only: string | undefined): string[] {
  const idWidth = Math.max(...found.map((task) => task.id.length), 0);
  const priorityWidth = Math.max(...found.map((task) => task.wire.priority.length), 0);
  const statuses = only === undefined ? TASK_STATUSES : [parseStatus(only)];
  return statuses.flatMap((status) => {
    const inStatus = found.filter((task) => task.wire.status === status);
    return [
      `${status} (${inStatus.length})`,
      ...inStatus.map((task) => {
        const labels = task.labels.length > 0 ? `  [${plain(task.labels.join(','))}]` : '';
        const hints = [
          task.wire.notBefore === null
            ? undefined
            : `starts ${localTime(new Date(task.wire.notBefore))}`,
          task.wire.held === true ? 'waits for a free slot of its schedule' : undefined,
          task.wire.wakeAt === null
            ? undefined
            : `${task.wire.waitCheck ? 'checks, gives up' : 'wakes'} ${localTime(new Date(task.wire.wakeAt))}`,
          task.wire.closed ? 'closed' : undefined,
          task.unreadable.length > 0 ? `cannot decrypt: ${task.unreadable.join(', ')}` : undefined,
        ].filter((hint) => hint !== undefined);
        const title = task.title === null ? UNREADABLE_TEXT : plain(task.title);
        return `  ${task.id.padEnd(idWidth)}  ${task.wire.priority.padEnd(priorityWidth)}  ${title}${labels}${hints.length > 0 ? `  (${hints.join(', ')})` : ''}`;
      }),
    ];
  });
}

export async function runTasks(ctx: Context, options: TasksOptions): Promise<void> {
  const status = options.status === undefined ? undefined : parseStatus(options.status);
  const project = options.project === undefined ? undefined : checkedProject(options.project);
  const s = await session(ctx);
  if (project !== undefined) s.require('projects');
  const { tasks } = await s.query(listTasksRoute, {
    all: options.all === true,
    ...(project === undefined ? {} : { projectId: project }),
  });
  const opened = await Promise.all(tasks.map((task) => openTask(s.keys, task)));
  const found =
    status === undefined ? opened : opened.filter((task) => task.wire.status === status);
  if (options.json === true) {
    ctx.out(JSON.stringify(found.map(taskJson)));
    return;
  }
  for (const line of formatTasks(found, options.status)) ctx.out(line);
}

export function renderThread(task: OpenTask, notes: readonly OpenNote[]): string {
  const { wire } = task;
  const sessionLine =
    wire.sessionId === null ? [] : [`session: ${wire.sessionId} · ${wire.machine ?? '-'}`];
  const lines = [
    `# ${task.title === null ? UNREADABLE_TEXT : plain(task.title)}`,
    '',
    `status: ${wire.status} · priority: ${wire.priority} · labels: ${plain(task.labels.join(', ')) || '-'}`,
    ...(task.agent === null ? [] : [`agent: ${task.agent}`]),
    ...(wire.forkOf === undefined ? [] : [`fork of: ${wire.forkOf}`]),
    ...task.prs.flatMap((pr) => (pr.url === null ? [] : [`pr: ${pr.url}`])),
    ...sessionLine,
    '',
    '## Input',
    '',
    task.input === null ? UNREADABLE_TEXT : task.input.trim() || '(empty)',
    '',
    '## Thread',
  ];
  const questionsById = new Map(
    notes.flatMap((note) =>
      note.questions === null ? [] : [[note.id, questionsOf(note.questions)] as const],
    ),
  );
  const ordered = [...notes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const note of ordered) {
    if (note.author === 'server') {
      lines.push('', `### from the board server, not board content · ${note.createdAt}`, '');
      lines.push(note.text === null ? UNREADABLE_TEXT : note.text.trim());
      continue;
    }
    lines.push('', `### ${note.author} ${note.kind} · ${note.createdAt}`, '');
    if (note.kind === 'question' && note.questions !== null) {
      const questions = questionsOf(note.questions);
      if (questions !== undefined) lines.push(formatQuestions(questions));
    }
    if (note.kind === 'answer' && note.answers !== null) {
      const answers = answersOf(note.answers);
      const asked =
        note.questionNoteId === null ? undefined : questionsById.get(note.questionNoteId);
      if (answers !== undefined) lines.push(formatAnswers(asked, answers));
    }
    if (note.unreadable) lines.push(UNREADABLE_TEXT);
    else if (note.text !== null && note.text.trim() !== '') lines.push(note.text.trim());
  }
  return plain(lines.join('\n'));
}

export async function readThread(
  ctx: Context,
  input: string,
): Promise<{ task: OpenTask; notes: OpenNote[] }> {
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const [task, { notes }] = await Promise.all([fetchTask(s, id), s.query(readNotesRoute, { id })]);
  return { task, notes: await Promise.all(notes.map((note) => openNote(s.keys, id, note))) };
}

export async function runShow(
  ctx: Context,
  input: string,
  options: { json?: boolean },
): Promise<void> {
  const { task, notes } = await readThread(ctx, input);
  if (options.json === true) {
    ctx.out(JSON.stringify({ task: taskJson(task), notes: notes.map(noteJson) }));
    return;
  }
  ctx.out(renderThread(task, notes));
}
