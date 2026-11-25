import { parse } from 'yaml';

import { plain } from '../../domain/rules.js';
import { editConfig, readConfigObject } from '../../config/file.js';
import { coveringDirectory, normalizePath, readLocalDirectories } from '../../directories/index.js';
import { formatDuration } from '../../domain/time.js';
import { isRecord } from '../../domain/values.js';
import { CliError, ReportedFailure, UsageError } from '../../errors.js';
import { MAX_FEEDS, isFeedName, parseFeed, FEED_NAME_RULE } from '../../feeds/definition.js';
import {
  discardFeedState,
  readFeedState,
  writeFeedState,
  type FeedRun,
} from '../../feeds/store.js';
import { readTextFile } from '../../input/text-file.js';
import type { Context } from '../context.js';
import { refuseInRun, session } from '../tasks/support.js';
import { feedsOf, publishFeeds, resolveProgram, runFeed } from './run.js';
import path from 'node:path';

const counted = (run: FeedRun): string => {
  const { listed, created, requeued, rescheduled, closed, failed } = run.counts;
  return `${listed} listed, ${created} created, ${requeued} requeued${rescheduled > 0 ? `, ${rescheduled} rescheduled` : ''}, ${closed} closed${failed > 0 ? `, ${failed} failed` : ''}`;
};

function describeRun(run: FeedRun | null): string {
  if (run === null) return 'never run';
  const when = new Date(run.at).toLocaleString();
  return run.ok
    ? `ran ${when}: ${counted(run)}`
    : `failed ${when}: ${plain(run.error ?? 'some items failed')} (${counted(run)})`;
}

function runList(ctx: Context): void {
  const { feeds, broken } = feedsOf(ctx);
  if (feeds.length === 0 && Object.keys(broken).length === 0) {
    ctx.out('no feeds; add one with "board feeds add <name> <file|->"');
    return;
  }
  for (const feed of feeds) {
    const state = readFeedState(ctx.dirs, feed.name);
    ctx.out(
      `${feed.name}  ${state.paused ? 'paused' : 'active'}  ${feed.integration} · ${feed.action}  every ${formatDuration(feed.everyMs)}  in ${plain(feed.dir)}${
        feed.agent === undefined ? '' : `  agent ${feed.agent}`
      }${feed.lane === undefined ? '' : `  lane ${feed.lane}`}`,
    );
    ctx.out(`  ${describeRun(state.last)}`);
  }
  for (const [name, problem] of Object.entries(broken)) {
    ctx.out(`${plain(name)}  not read: ${plain(problem)}`);
  }
}

async function readEntry(ctx: Context, source: string | undefined): Promise<unknown> {
  if (source === undefined) throw new UsageError('usage: board feeds add <name> <file|->');
  const text =
    source === '-'
      ? await ctx.rt.readStdin()
      : readTextFile(path.resolve(ctx.rt.cwd(), source), 64 * 1024);
  try {
    return parse(text);
  } catch {
    throw new UsageError('the feed entry is not valid YAML or JSON');
  }
}

async function runAdd(
  ctx: Context,
  name: string | undefined,
  source: string | undefined,
): Promise<void> {
  if (name === undefined || !isFeedName(name))
    throw new UsageError(`a feed name must be ${FEED_NAME_RULE}`);
  const entry = await readEntry(ctx, source);
  const feed = parseFeed(name, entry);
  if (typeof feed === 'string') throw new UsageError(feed);
  const local = readLocalDirectories(ctx.dirs.config);
  if (local.configured && coveringDirectory(local.entries, normalizePath(feed.dir)) === undefined) {
    throw new UsageError(
      `${plain(feed.dir)} is not a listed directory; run "board dirs add" there first`,
    );
  }
  await resolveProgram(ctx, feed.integration).catch((error: unknown) => {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  });
  const existing = readConfigObject(ctx.dirs.config).feeds;
  const replaced = isRecord(existing) && name in existing;
  if (!replaced && isRecord(existing) && Object.keys(existing).length >= MAX_FEEDS) {
    throw new UsageError(`a machine runs at most ${MAX_FEEDS} feeds`);
  }
  if (ctx.dryRun) {
    ctx.out('DRY feeds add');
    return;
  }
  editConfig(ctx.dirs.config, (document) => {
    document.setIn(['feeds', name], entry);
  });
  ctx.out(
    `${replaced ? 'changed' : 'added'} feed ${name}: ${feed.integration} · ${feed.action} every ${formatDuration(feed.everyMs)} in ${plain(feed.dir)}`,
  );
  await publish(ctx);
}

async function publish(ctx: Context): Promise<void> {
  const s = await session(ctx).catch(() => null);
  if (s !== null) await publishFeeds(ctx, s);
}

function requireFeed(ctx: Context, name: string | undefined) {
  if (name === undefined) throw new UsageError('usage: board feeds <rm|run|pause|resume> <name>');
  const found = feedsOf(ctx).feeds.find((feed) => feed.name === name);
  if (found === undefined) {
    const names = feedsOf(ctx).feeds.map((feed) => feed.name);
    throw new UsageError(
      `no feed "${plain(name).slice(0, 40)}"; ${names.length === 0 ? 'there are none' : `there are ${names.join(', ')}`}`,
    );
  }
  return found;
}

export async function runFeeds(ctx: Context, action: readonly string[]): Promise<void> {
  const [verb = 'list', name, ...extra] = action;
  if (verb === 'list') {
    runList(ctx);
    return;
  }
  refuseInRun(ctx, `board feeds ${verb}`);
  if (verb === 'add') {
    if (extra.length > 1) throw new UsageError('usage: board feeds add <name> <file|->');
    await runAdd(ctx, name, extra[0]);
    return;
  }
  if (extra.length > 0) throw new UsageError(`usage: board feeds ${verb} <name>`);
  const feed = requireFeed(ctx, name);
  if (verb === 'rm') {
    if (ctx.dryRun) {
      ctx.out('DRY feeds rm');
      return;
    }
    editConfig(ctx.dirs.config, (document) => {
      document.deleteIn(['feeds', feed.name]);
      const rest = document.get('feeds');
      if (
        rest !== null &&
        typeof rest === 'object' &&
        'items' in rest &&
        (rest.items as unknown[]).length === 0
      ) {
        document.delete('feeds');
      }
    });
    discardFeedState(ctx.dirs, feed.name);
    ctx.out(`removed feed ${feed.name}; the tasks it made stay on the board`);
    await publish(ctx);
    return;
  }
  if (verb === 'pause' || verb === 'resume') {
    if (!ctx.dryRun) {
      writeFeedState(ctx.dirs, feed.name, {
        ...readFeedState(ctx.dirs, feed.name),
        paused: verb === 'pause',
      });
    } else ctx.out(`DRY feeds ${verb}`);
    ctx.out(`${verb === 'pause' ? 'paused' : 'resumed'} feed ${feed.name}`);
    await publish(ctx);
    return;
  }
  if (verb === 'run') {
    const s = await session(ctx);
    const run = await runFeed(ctx, s, feed);
    ctx.out(`feed ${feed.name} ${describeRun(run)}`);
    await publishFeeds(ctx, s);
    if (!run.ok) throw new ReportedFailure(1);
    return;
  }
  throw new CliError(
    `unknown action "${plain(verb).slice(0, 40)}"; use list, add, rm, run, pause or resume`,
  );
}
