import { askRoute } from '@rumo/contract';
import { bindings, seal } from '@rumo/sealing';

import { UsageError } from '../../errors.js';
import { formatQuestions, parseQuestions } from '../../domain/questions.js';
import { checkedSize } from '../../domain/rules.js';
import { readNoteFile } from '../../input/note-file.js';
import { ApiError } from '../../transport/errors.js';
import type { Context } from '../context.js';
import { confirm, fenceOf, resolveTask, session, taskLink } from './support.js';

export async function runAsk(ctx: Context, input: string, file: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readNoteFile(file, ctx.rt.platform));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UsageError(`the question file is not valid JSON: ${file}`);
    }
    throw error;
  }
  const questions = parseQuestions(parsed);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const noteBinding = (field: 'note.body' | 'note.questions') =>
    bindings.note({ field, taskId: id, author: 'agent', kind: 'question' });
  const document = JSON.stringify({ questions });
  checkedSize('note.questions', document, 'the questions');
  try {
    await s.command(askRoute, {
      id,
      ...fenceOf(ctx, id),
      body: await seal(s.keys, noteBinding('note.body'), formatQuestions(questions)),
      questions: await seal(s.keys, noteBinding('note.questions'), document),
    });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 403)) {
      throw new UsageError(
        `${id} cannot take a question: ${error.message}. The board takes questions only from the run that holds the task, so nothing was asked. If you are that run, it was taken back or has ended: do not ask again, end your turn.`,
      );
    }
    throw error;
  }
  const count = `${questions.length} question${questions.length > 1 ? 's' : ''}`;
  confirm(ctx, `asked ${count} on ${id}, now in needs-me  ${taskLink(s, id)}`);
}
