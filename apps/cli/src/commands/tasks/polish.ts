import { addNoteRoute, taskId } from '@agent-board/contract';

import { UsageError } from '../../errors.js';
import { checkedSize } from '../../domain/rules.js';
import { readNoteFile } from '../../input/note-file.js';
import type { Context } from '../context.js';
import { sealedNote } from './notes.js';
import { confirm, resolveTask, session, taskLink } from './support.js';

export async function runPolish(
  ctx: Context,
  input: string,
  options: { title: string; file: string },
): Promise<void> {
  const run = ctx.runTask;
  if (run === null) {
    throw new UsageError(
      'board polish only works inside a board run: it posts on the task the run is for',
    );
  }
  if (!taskId.safeParse(run).success) throw new UsageError('AGENT_BOARD_TASK is not a task id');
  const title = options.title.trim();
  if (title === '') throw new UsageError('--title needs a title');
  if (/[\r\n]/.test(title)) throw new UsageError('the polished title must be one line');
  checkedSize('title', title, 'the polished title');
  const prompt = readNoteFile(options.file, ctx.rt.platform);
  if (prompt === '') throw new UsageError('the polished prompt is empty');
  checkedSize('input', prompt, 'the polished prompt');
  const s = await session(ctx);
  const target = await resolveTask(ctx, s, input);
  if (target === run) {
    throw new UsageError(
      'a task cannot post a polished prompt for itself; name the task to polish',
    );
  }
  const note = await sealedNote(
    s.keys,
    run,
    'agent',
    'polish',
    JSON.stringify({ target, title, prompt }),
  );
  await s.command(addNoteRoute, {
    id: run,
    author: 'agent',
    kind: 'polish',
    body: note.body,
    preview: note.preview,
  });
  confirm(ctx, `posted a polished prompt for ${target} on ${run}  ${taskLink(s, run)}`);
}
