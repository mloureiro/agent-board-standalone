import { forkRoute, taskId } from '@rumo/contract';
import { bindings, seal } from '@rumo/sealing';

import { UsageError } from '../../errors.js';
import { checkedSize } from '../../domain/rules.js';
import { textOf } from '../../input/text.js';
import type { Context } from '../context.js';
import { confirm, fetchTask, newTaskId, resolveTask, session, taskLink } from '../tasks/support.js';
import { asOwner, userCommand } from './support.js';

export interface ForkOptions {
  readonly title: string;
  readonly json?: boolean;
}

export async function runFork(
  ctx: Context,
  input: string,
  words: readonly string[],
  options: ForkOptions,
): Promise<void> {
  userCommand(ctx, 'fork');
  const title = options.title.trim();
  if (title === '') throw new UsageError('--title needs a title');
  checkedSize('title', title, 'the title');
  const prompt = await textOf(ctx.rt, words);
  checkedSize('input', prompt, 'the instructions');
  const s = await session(ctx);
  s.require('forks');
  const parentId = await resolveTask(ctx, s, input);
  const { agent, wire } = await fetchTask(s, parentId);
  let id = newTaskId();
  while (!taskId.safeParse(id).success) id = newTaskId();
  const request = {
    id,
    parentId,
    title: await seal(s.keys, bindings.title({ task: id }), title),
    input: await seal(
      s.keys,
      bindings.input({
        origin: { task: id },
        creator: 'user',
        forkOf: parentId,
        agent,
        directoryId: wire.directoryId,
      }),
      prompt,
    ),
    directoryId: wire.directoryId,
    ...(agent === null ? {} : { agent: await seal(s.keys, bindings.agent({ task: id }), agent) }),
  };
  await asOwner(s, parentId, () => s.command(forkRoute, request));
  if (options.json === true) {
    ctx.out(JSON.stringify({ id, url: taskLink(s, id) }));
    return;
  }
  confirm(ctx, `forked ${parentId} as ${id}  ${taskLink(s, id)}`);
}
