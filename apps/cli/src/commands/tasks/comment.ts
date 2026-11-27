import { addNoteRoute } from '@rumo/contract';

import { UsageError } from '../../errors.js';
import { readNoteFile } from '../../input/note-file.js';
import { textOf } from '../../input/text.js';
import type { Context } from '../context.js';
import { sealedNote, sealedSuggestion } from './notes.js';
import { confirm, resolveTask, session, taskLink } from './support.js';

export interface CommentOptions {
  readonly suggest?: string;
  readonly suggestFile?: string;
}

export async function runComment(
  ctx: Context,
  input: string,
  words: readonly string[],
  options: CommentOptions,
): Promise<void> {
  const misplaced = /^(--suggest(?:-file)?)(?:=|$)/.exec(words[0] ?? '')?.[1];
  if (misplaced !== undefined) {
    throw new UsageError(
      `${misplaced} goes before the task: rumo comment ${misplaced} "<${misplaced === '--suggest' ? 'reply' : 'path'}>" <task> <text...>`,
    );
  }
  if (options.suggest !== undefined && options.suggestFile !== undefined) {
    throw new UsageError('give --suggest or --suggest-file, not both');
  }
  const text = await textOf(ctx.rt, words);
  const suggestion =
    options.suggestFile === undefined
      ? options.suggest
      : readNoteFile(options.suggestFile, ctx.rt.platform);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const note = await sealedNote(s.keys, id, 'agent', 'comment', text);
  await s.command(addNoteRoute, {
    id,
    author: 'agent',
    kind: 'comment',
    body: note.body,
    preview: note.preview,
    ...(suggestion === undefined || suggestion === ''
      ? {}
      : { suggestion: await sealedSuggestion(s.keys, id, suggestion) }),
  });
  confirm(ctx, `commented on ${id}  ${taskLink(s, id)}`);
}
