import path from 'node:path';

import { getTaskRoute, setClosedRoute, setFeedsRoute } from '@agent-board/contract';
import { bindings, blindIndex, seal } from '@agent-board/sealing';

import { CliError } from '../../errors.js';
import { readConfigObject } from '../../config/file.js';
import { isRecord } from '../../domain/values.js';
import { parseScheduleArgs } from '../../scheduling/args.js';
import { checkedFields, scheduleKeyed } from '../schedule/schedule.js';
import { asOwner } from '../user/support.js';
import type { Context } from '../context.js';
import { loadMarketplace, pinProblem } from '../../plugins/load.js';
import { checkoutDir, readRegistry } from '../../plugins/registry.js';
import type { Session } from '../../transport/session.js';
import { parseFeed, type FeedConfig } from '../../feeds/definition.js';
import { parseItems } from '../../feeds/items.js';
import { readFeedState, writeFeedState, type FeedCounts, type FeedRun } from '../../feeds/store.js';

const PROGRAM_TIMEOUT_MS = 120_000;
const PROGRAM_MAX_BYTES = 1024 * 1024;

export function feedsOf(ctx: Context): { feeds: FeedConfig[]; broken: Record<string, string> } {
  const raw = readConfigObject(ctx.dirs.config).feeds;
  const feeds: FeedConfig[] = [];
  const broken: Record<string, string> = {};
  if (!isRecord(raw)) return { feeds, broken };
  for (const [name, entry] of Object.entries(raw)) {
    const parsed = parseFeed(name, entry);
    if (typeof parsed === 'string') broken[name] = parsed;
    else feeds.push(parsed);
  }
  return { feeds, broken };
}

export async function resolveProgram(ctx: Context, integration: string): Promise<string> {
  const [marketplace = '', key = ''] = integration.split(':');
  const installed = readRegistry(ctx.dirs)[marketplace];
  if (installed === undefined) {
    throw new CliError(
      `marketplace ${marketplace} is not installed: run "board plugins install <url>"`,
    );
  }
  const checkout = checkoutDir(ctx.dirs, marketplace);
  const problem = await pinProblem(ctx.rt, marketplace, checkout, installed.commit);
  if (problem !== null) throw new CliError(problem);
  const loaded = await loadMarketplace(ctx.rt, checkout, installed.commit);
  if (typeof loaded === 'string') throw new CliError(loaded);
  const found = loaded.integrations[key];
  if (found === undefined) throw new CliError(`marketplace ${marketplace} has no feed ${key}`);
  return path.join(checkout, found.program);
}

async function listItems(ctx: Context, feed: FeedConfig) {
  const program = await resolveProgram(ctx, feed.integration);
  const result = await ctx.rt.exec(program, [feed.action], {
    cwd: feed.dir,
    timeoutMs: PROGRAM_TIMEOUT_MS,
    maxBytes: PROGRAM_MAX_BYTES,
  });
  if (result.code !== 0)
    throw new CliError(`${feed.integration} ${feed.action} exited ${result.code}`);
  const items = parseItems(result.stdout);
  if (typeof items === 'string') throw new CliError(items);
  return items;
}

export async function runFeed(ctx: Context, s: Session, feed: FeedConfig): Promise<FeedRun> {
  const state = readFeedState(ctx.dirs, feed.name);
  const counts = { listed: 0, created: 0, requeued: 0, rescheduled: 0, closed: 0, failed: 0 };
  let error: string | null = null;
  const items: Record<string, string> = { ...state.items };
  const placed: Context = { ...ctx, rt: { ...ctx.rt, cwd: () => feed.dir } };
  try {
    const listed = await listItems(ctx, feed);
    counts.listed = listed.length;
    const now = new Date();
    for (const item of listed) {
      try {
        const args = parseScheduleArgs(
          {
            key: `feed:${feed.name}:${item.key}`,
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.version === undefined ? {} : { version: item.version }),
            ...(feed.agent === undefined ? {} : { agent: feed.agent }),
            ...(feed.lane === undefined ? {} : { lane: feed.lane }),
          },
          [item.prompt],
          now,
        );
        const outcome = await scheduleKeyed(placed, s, args, checkedFields(args), args.key ?? '');
        if (outcome === null) continue;
        items[item.key] = outcome.task.id;
        if (outcome.result === 'created') counts.created += 1;
        if (outcome.result === 'requeued') counts.requeued += 1;
        if (outcome.result === 'rescheduled') counts.rescheduled += 1;
      } catch {
        counts.failed += 1;
      }
    }
    const present = new Set(listed.map((item) => item.key));
    for (const [key, id] of Object.entries(state.items)) {
      if (present.has(key)) continue;
      try {
        const task = await s.query(getTaskRoute, { id });
        if (task.status === 'todo' && task.next === 'fresh' && !task.closed) {
          await asOwner(s, id, () => s.command(setClosedRoute, { id, closed: true }));
          counts.closed += 1;
        }
        delete items[key];
      } catch {
        counts.failed += 1;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const run: FeedRun = {
    at: new Date().toISOString(),
    ok: error === null && counts.failed === 0,
    error,
    counts: counts as FeedCounts,
  };
  if (!ctx.dryRun) writeFeedState(ctx.dirs, feed.name, { ...state, last: run, items });
  return run;
}

export async function publishFeeds(ctx: Context, s: Session): Promise<void> {
  if (s.dryRun || !s.supports('feeds')) return;
  const { feeds } = feedsOf(ctx);
  const document = JSON.stringify({
    feeds: feeds.map((feed) => {
      const state = readFeedState(ctx.dirs, feed.name);
      return {
        name: feed.name,
        integration: feed.integration,
        action: feed.action,
        everyMs: feed.everyMs,
        paused: state.paused,
        last: state.last,
      };
    }),
  });
  const index = await blindIndex(s.keys, `feeds:${s.machine}:${document}`);
  if (index === s.info.feedsIndex) return;
  await s.command(setFeedsRoute, {
    feeds: await seal(s.keys, bindings.machineDocument('machine.feeds', s.machine), document),
    index,
  });
}
