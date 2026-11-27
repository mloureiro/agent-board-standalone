import { addPrRoute, removePrRoute } from '@rumo/contract';
import { bindings, seal } from '@rumo/sealing';

import { UsageError } from '../../errors.js';
import { checkedPrUrl, prUrlIn } from '../../domain/rules.js';
import type { Context } from '../context.js';
import { confirm, fetchTask, resolveTask, session, taskLink } from './support.js';

export async function runPr(
  ctx: Context,
  input: string,
  url: string,
  options: { remove?: boolean },
): Promise<void> {
  checkedPrUrl(url);
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  const task = await fetchTask(s, id);
  const reported = task.prs.find((pr) => pr.url === url);
  if (options.remove === true) {
    if (reported !== undefined) {
      await s.command(removePrRoute, { id, pr: reported.id });
      confirm(ctx, `removed ${url} from ${id}  ${taskLink(s, id)}`);
    } else if (task.input !== null && prUrlIn(task.input) === url) {
      throw new UsageError(
        `${url} is the pull request the prompt of ${id} names, not a reported one, and cannot be removed`,
      );
    } else {
      confirm(ctx, `${url} was not reported for ${id}; nothing changed  ${taskLink(s, id)}`);
    }
    return;
  }
  if (reported === undefined) {
    await s.command(addPrRoute, { id, pr: await seal(s.keys, bindings.pr(id), url) });
  }
  confirm(ctx, `reported ${url} for ${id}  ${taskLink(s, id)}`);
}
