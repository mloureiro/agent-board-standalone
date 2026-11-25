import { answerRoute, dismissQuestionRoute, readNotesRoute } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { CliError, UsageError } from '../../errors.js';
import { checkedSize } from '../../domain/rules.js';
import {
  composeAnswers,
  formatAnswers,
  questionsOf,
  type Question,
} from '../../domain/questions.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { openNote } from '../tasks/open.js';
import { sealedNote } from '../tasks/notes.js';
import { confirm, fetchTask, resolveTask, session, taskLink } from '../tasks/support.js';
import { asOwner, userCommand } from './support.js';

export interface AnswerOptions {
  readonly pick?: readonly string[];
  readonly other?: readonly string[];
}

interface OpenQuestion {
  readonly noteId: string;
  readonly questions: readonly Question[];
}

async function openQuestionOf(s: Session, id: string): Promise<OpenQuestion> {
  const task = await fetchTask(s, id);
  if (!task.wire.openQuestion) throw new CliError(`${id} has no open question`);
  const { notes } = await s.query(readNotesRoute, { id });
  const asked = notes
    .filter((note) => note.kind === 'question' && note.author !== 'server')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (asked === undefined) throw new CliError(`${id} has no question note to answer`);
  const opened = await openNote(s.keys, id, asked);
  const questions = opened.questions === null ? undefined : questionsOf(opened.questions);
  if (questions === undefined) throw new CliError(`the open question of ${id} cannot be read`);
  return { noteId: asked.id, questions };
}

export async function runAnswer(
  ctx: Context,
  input: string,
  options: AnswerOptions,
): Promise<void> {
  userCommand(ctx, 'answer');
  const picks = options.pick ?? [];
  const others = (options.other ?? []).map((other) => other.trim());
  if (picks.length === 0 && others.length === 0) {
    throw new UsageError('give the answer: --pick <option label> and/or --other <text>');
  }
  if (others.includes('')) throw new UsageError('--other needs a text');
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const { noteId, questions } = await openQuestionOf(s, id);
  const answers = composeAnswers(questions, picks, others);
  const document = JSON.stringify(answers);
  checkedSize('note.answers', document, 'the answer');
  const message = await sealedNote(s.keys, id, 'user', 'answer', formatAnswers(questions, answers));
  const sealedAnswers = await seal(
    s.keys,
    bindings.note({ field: 'note.answers', taskId: id, author: 'user', kind: 'answer' }),
    document,
  );
  await asOwner(s, id, () =>
    s.command(answerRoute, { id, questionNoteId: noteId, answers: sealedAnswers, message }),
  );
  confirm(ctx, `answered the question on ${id}  ${taskLink(s, id)}`);
}

export async function runDismiss(ctx: Context, input: string): Promise<void> {
  userCommand(ctx, 'dismiss');
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const { noteId } = await openQuestionOf(s, id);
  await asOwner(s, id, () => s.command(dismissQuestionRoute, { id, questionNoteId: noteId }));
  confirm(ctx, `dismissed the question on ${id}  ${taskLink(s, id)}`);
}
