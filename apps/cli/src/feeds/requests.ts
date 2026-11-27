import { ackFeedRequestsRoute } from '@rumo/contract';

import { feedsOf, publishFeeds } from '../commands/feeds/run.js';
import type { Context } from '../commands/context.js';
import type { Session } from '../transport/session.js';
import { feedIdOf } from './ids.js';
import { readFeedState, writeFeedState } from './store.js';

const REQUEST = /^(pause|resume|run):([0-9a-f]{16})$/;

export async function applyFeedRequests(
  ctx: Context,
  s: Session,
  log: (line: string) => void,
): Promise<void> {
  if (s.dryRun || !s.supports('feeds')) return;
  const requests = s.info.feedRequests;
  if (requests.length > 0) {
    const { feeds } = feedsOf(ctx);
    for (const request of requests) {
      const match = REQUEST.exec(request);
      const feed = feeds.find((candidate) => feedIdOf(candidate.name) === match?.[2]);
      if (match === null || feed === undefined) continue;
      const state = readFeedState(ctx.dirs, feed.name);
      if (match[1] === 'pause') writeFeedState(ctx.dirs, feed.name, { ...state, paused: true });
      if (match[1] === 'resume') writeFeedState(ctx.dirs, feed.name, { ...state, paused: false });
      if (match[1] === 'run') {
        writeFeedState(ctx.dirs, feed.name, { ...state, runRequestedAt: new Date().toISOString() });
      }
      log(`FEED ${feed.name} ${match[1]} from the board`);
    }
    await s.command(ackFeedRequestsRoute, { requests: [...requests] });
  }
  await publishFeeds(ctx, s);
}
