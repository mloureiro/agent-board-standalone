import { replyRoute, sendRoute, stopRoute } from '@agent-board/contract';

import { textOf } from '../../input/text.js';
import type { Context } from '../context.js';
import { sealedNote } from '../tasks/notes.js';
import { confirm, resolveTask, session, taskLink } from '../tasks/support.js';
import { asOwner, userCommand } from './support.js';

export async function runReply(
  ctx: Context,
  input: string,
  words: readonly string[],
  options: { resume?: boolean },
): Promise<void> {
  userCommand(ctx, 'reply');
  const text = await textOf(ctx.rt, words);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const message = await sealedNote(s.keys, id, 'user', 'comment', text);
  await asOwner(s, id, () =>
    s.command(replyRoute, { id, message, resume: options.resume === true }),
  );
  confirm(
    ctx,
    `${options.resume === true ? 'replied and resumed' : 'replied on'} ${id}  ${taskLink(s, id)}`,
  );
}

export async function runSend(
  ctx: Context,
  input: string,
  words: readonly string[],
): Promise<void> {
  userCommand(ctx, 'send');
  const text = await textOf(ctx.rt, words);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const message = await sealedNote(s.keys, id, 'user', 'comment', text);
  await asOwner(s, id, () => s.command(sendRoute, { id, message }));
  confirm(ctx, `sent to the agent on ${id}  ${taskLink(s, id)}`);
}

export async function runStop(
  ctx: Context,
  input: string,
  words: readonly string[],
): Promise<void> {
  userCommand(ctx, 'stop');
  const text = words.length === 0 ? undefined : await textOf(ctx.rt, words);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const message =
    text === undefined ? undefined : await sealedNote(s.keys, id, 'user', 'comment', text);
  await asOwner(s, id, () =>
    s.command(stopRoute, message === undefined ? { id } : { id, message }),
  );
  confirm(ctx, `stopped ${id}  ${taskLink(s, id)}`);
}
