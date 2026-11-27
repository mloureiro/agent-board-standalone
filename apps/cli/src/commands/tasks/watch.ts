import { UsageError } from '../../errors.js';
import { oneLine, plain } from '../../domain/rules.js';
import {
  MAX_WAIT_MS,
  formatDuration,
  localTime,
  parseDuration,
  parseStart,
} from '../../domain/time.js';
import { publishWatches } from '../../watch/publish.js';
import {
  CI_EVERY_MS,
  MAX_COMMAND_CHARS,
  MAX_IGNORE_CHARS,
  MAX_IGNORE_PATTERNS,
  MIN_COMMAND_EVERY_MS,
  PR_MERGED_EVERY_MS,
  PR_REVIEW_EVERY_MS,
  isIgnorePattern,
  isPrUrl,
  isWatchName,
} from '../../watch/shapes.js';
import { WatchStore, newWatchId, type WatchDef } from '../../watch/store.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { confirm, fetchTask, resolveTask, session } from './support.js';

export interface WatchOptions {
  readonly ci?: string | true;
  readonly prReview?: string | true;
  readonly prMerged?: string | true;
  readonly required?: boolean;
  readonly ignore?: readonly string[];
  readonly name?: string;
  readonly stream?: boolean;
  readonly every?: string;
  readonly timeout?: string;
  readonly in?: string;
  readonly at?: string;
}

export const DEFAULT_WATCH_EVERY = '30s';
export const DEFAULT_WATCH_TIMEOUT = '2h';
export const DEFAULT_REVIEW_TIMEOUT = '1d';
export const DEFAULT_PR_MERGED_TIMEOUT = '7d';
export const KEEP_WORKING =
  'Keep working if there is work; end your turn when there is none: the task waits and resumes with the event.';

const PR_NUMBER = /^[1-9]\d{0,8}$/;
const PR_RESOLVE_LIMIT_MS = 60_000;
const PR_OUTPUT_LIMIT = 64 * 1024;

export type WatchPlan = {
  readonly name: string;
  readonly deadline: Date;
} & (
  | {
      readonly kind: 'ci';
      readonly pr: string | undefined;
      readonly required: boolean;
      readonly ignore: string[];
    }
  | { readonly kind: 'pr-review'; readonly pr: string | undefined }
  | { readonly kind: 'pr-merged'; readonly pr: string | undefined }
  | { readonly kind: 'command'; readonly command: string; readonly everyMs: number }
  | { readonly kind: 'stream'; readonly command: string }
  | { readonly kind: 'timer' }
);

function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function checkedName(name: string): string {
  if (!isWatchName(name)) {
    throw new UsageError(
      `--name must be 1-32 characters of lowercase letters, digits and hyphens, starting with a letter or digit; got "${oneLine(name, 40)}"`,
    );
  }
  return name;
}

function checkedIgnore(patterns: readonly string[]): string[] {
  if (patterns.length > MAX_IGNORE_PATTERNS) {
    throw new UsageError(`--ignore may be given at most ${MAX_IGNORE_PATTERNS} times`);
  }
  for (const pattern of patterns) {
    if (!isIgnorePattern(pattern)) {
      throw new UsageError(
        `--ignore takes a check name, with * for any characters: 1-${MAX_IGNORE_CHARS} characters, no control characters; got "${oneLine(pattern, 40)}"`,
      );
    }
  }
  return [...new Set(patterns)];
}

export function parseWatchOptions(
  options: WatchOptions,
  words: readonly string[],
  now: Date,
): WatchPlan {
  const { ci, prReview, prMerged, required, ignore, name, stream, every, timeout } = options;
  if (options.in !== undefined && options.at !== undefined) {
    throw new UsageError('give --in or --at, not both');
  }
  if (stream === true && words.length === 0) {
    throw new UsageError('--stream goes with a command after --');
  }
  if (stream === true && every !== undefined) {
    throw new UsageError(
      'give --stream or --every, not both: a stream runs its command once and reports what it prints',
    );
  }
  const sources = [
    ci !== undefined,
    prReview !== undefined,
    prMerged !== undefined,
    words.length > 0,
    options.in !== undefined || options.at !== undefined,
  ].filter(Boolean).length;
  if (sources !== 1) {
    throw new UsageError(
      'give exactly one source: --ci for the CI of a PR, --pr-review for its reviews and comments, --pr-merged for its merge, a command after -- (with --name; --stream to follow its output), or --in/--at for a timer',
    );
  }
  if (required === true && ci === undefined) throw new UsageError('--required goes with --ci');
  if (ignore !== undefined && ci === undefined) throw new UsageError('--ignore goes with --ci');
  const timeoutMs = (fallback: string): number => {
    const ms = parseDuration(timeout ?? fallback, true);
    if (ms > MAX_WAIT_MS) {
      throw new UsageError(`--timeout may be at most ${formatDuration(MAX_WAIT_MS)}`);
    }
    return ms;
  };
  const after = (ms: number): Date => new Date(now.getTime() + ms);
  const noEvery = (what: string, ms: number): void => {
    if (every !== undefined) {
      throw new UsageError(
        `--every goes with a command; ${what} looks every ${formatDuration(ms)}`,
      );
    }
  };
  if (ci !== undefined) {
    noEvery('a CI watch', CI_EVERY_MS);
    return {
      kind: 'ci',
      name: checkedName(name ?? 'ci'),
      pr: ci === true ? undefined : ci,
      required: required === true,
      ignore: checkedIgnore(ignore ?? []),
      deadline: after(timeoutMs(DEFAULT_WATCH_TIMEOUT)),
    };
  }
  if (prReview !== undefined) {
    noEvery('a review watch', PR_REVIEW_EVERY_MS);
    return {
      kind: 'pr-review',
      name: checkedName(name ?? 'review'),
      pr: prReview === true ? undefined : prReview,
      deadline: after(timeoutMs(DEFAULT_REVIEW_TIMEOUT)),
    };
  }
  if (prMerged !== undefined) {
    noEvery('a --pr-merged watch', PR_MERGED_EVERY_MS);
    return {
      kind: 'pr-merged',
      name: checkedName(name ?? 'pr-merged'),
      pr: prMerged === true ? undefined : prMerged,
      deadline: after(timeoutMs(DEFAULT_PR_MERGED_TIMEOUT)),
    };
  }
  if (words.length > 0) {
    if (name === undefined) {
      throw new UsageError('a command watch needs --name <name>: it tells the events apart');
    }
    const command = words.length === 1 ? (words[0] ?? '') : words.map(shellQuote).join(' ');
    if (command.trim() === '') throw new UsageError('the command after -- is empty');
    if (command.length > MAX_COMMAND_CHARS) {
      throw new UsageError(
        `the command is longer than ${MAX_COMMAND_CHARS} characters; put it in a script`,
      );
    }
    if (stream === true) {
      return {
        kind: 'stream',
        name: checkedName(name),
        command,
        deadline: after(timeoutMs(DEFAULT_WATCH_TIMEOUT)),
      };
    }
    const everyMs = parseDuration(every ?? DEFAULT_WATCH_EVERY, true);
    if (everyMs < MIN_COMMAND_EVERY_MS) {
      throw new UsageError(`--every must be at least ${formatDuration(MIN_COMMAND_EVERY_MS)}`);
    }
    return {
      kind: 'command',
      name: checkedName(name),
      command,
      everyMs,
      deadline: after(timeoutMs(DEFAULT_WATCH_TIMEOUT)),
    };
  }
  if (every !== undefined || timeout !== undefined) {
    throw new UsageError(
      '--every and --timeout go with --ci, --pr-review, --pr-merged or a command; a timer ends at its time',
    );
  }
  const deadline = parseStart({ in: options.in, at: options.at }, now);
  if (deadline === undefined) throw new UsageError('give --in or --at');
  if (deadline.getTime() - now.getTime() > MAX_WAIT_MS) {
    throw new UsageError(`a timer may last at most ${formatDuration(MAX_WAIT_MS)}`);
  }
  return { kind: 'timer', name: checkedName(name ?? 'timer'), deadline };
}

export function reportedPr(
  prs: readonly { readonly url: string | null; readonly state: string | null }[],
): string | null {
  const known = prs.flatMap((pr) => (pr.url === null ? [] : [{ url: pr.url, state: pr.state }]));
  const open = known.filter((pr) => pr.state !== 'merged' && pr.state !== 'closed');
  return (open.at(-1) ?? known.at(-1))?.url ?? null;
}

async function resolvePr(
  ctx: Context,
  id: string,
  flag: '--ci' | '--pr-review' | '--pr-merged',
  given: string | undefined,
  taskPr: string | null,
): Promise<{ url: string; head: string }> {
  const arg = (given ?? taskPr)?.trim();
  if (arg === undefined || arg === '')
    throw new UsageError(`give the PR: rumo watch ${id} ${flag} <url>`);
  if (!isPrUrl(arg) && !PR_NUMBER.test(arg)) {
    throw new UsageError(`${flag} takes a PR URL or number; got "${oneLine(arg, 60)}"`);
  }
  const cwd = ctx.rt.cwd();
  let result;
  try {
    result = await ctx.rt.exec('gh', ['pr', 'view', arg, '--json', 'url,headRefOid'], {
      timeoutMs: PR_RESOLVE_LIMIT_MS,
      maxBytes: PR_OUTPUT_LIMIT,
      cwd,
    });
  } catch {
    throw new UsageError(`cannot read the PR ${oneLine(arg, 60)} in ${cwd}: gh did not run`);
  }
  let info: { url?: unknown; headRefOid?: unknown } = {};
  try {
    info = JSON.parse(result.stdout) as typeof info;
  } catch {
    info = {};
  }
  const { url, headRefOid: head } = info;
  if (
    result.code !== 0 ||
    typeof url !== 'string' ||
    !isPrUrl(url) ||
    typeof head !== 'string' ||
    !/^[0-9a-f]{40}$/.test(head)
  ) {
    throw new UsageError(`cannot read the PR ${oneLine(arg, 60)} in ${cwd}: gh did not answer`);
  }
  return { url, head };
}

async function reviewerLogin(ctx: Context): Promise<string | undefined> {
  try {
    const result = await ctx.rt.exec('gh', ['api', 'user', '--jq', '.login'], {
      timeoutMs: PR_RESOLVE_LIMIT_MS,
      maxBytes: PR_OUTPUT_LIMIT,
      cwd: ctx.rt.cwd(),
    });
    const login = result.stdout.trim();
    return result.code === 0 && /^(app\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,99}(\[bot\])?$/.test(login)
      ? login
      : undefined;
  } catch {
    return undefined;
  }
}

function requireOwnTask(ctx: Context, id: string): void {
  if (ctx.runTask !== null && ctx.runTask !== id) {
    throw new UsageError(
      `${id} is not the task of this run (${ctx.runTask}): a run watches its own task only`,
    );
  }
}

async function requireHere(s: Session, id: string, what: string) {
  const task = await fetchTask(s, id);
  if (task.wire.machine !== s.machine) {
    throw new UsageError(
      `${id} runs on ${task.wire.machine ?? 'no machine'}, not on ${s.machine}: ${what} lives on the task's machine`,
    );
  }
  return task;
}

function summaryOf(def: WatchDef): string {
  const { source } = def;
  switch (source.kind) {
    case 'timer':
      return `waiting until ${localTime(new Date(def.deadline))}`;
    case 'stream':
      return 'the watch unit starts the command within seconds and reports what it prints';
    case 'command':
      return `running the command every ${formatDuration(def.everyMs)}`;
    case 'ci':
      return `looking at the checks of ${source.pr}`;
    case 'pr-review':
      return `looking at the reviews and comments of ${source.pr}`;
    case 'pr-merged':
      return `looking for the merge of ${source.pr}`;
  }
}

export async function runWatch(
  ctx: Context,
  input: string,
  options: WatchOptions,
  words: readonly string[],
): Promise<void> {
  const now = new Date();
  const plan = parseWatchOptions(options, words, now);
  const s = await session(ctx);
  s.require('watches');
  const id = await resolveTask(ctx, s, input);
  requireOwnTask(ctx, id);
  const task = await requireHere(s, id, 'a watch');
  if (task.wire.status !== 'running' && task.wire.status !== 'waiting') {
    throw new UsageError(
      `${id} is ${task.wire.status}: only a running or waiting task can have a watch`,
    );
  }
  if (
    (plan.kind === 'command' || plan.kind === 'stream') &&
    (ctx.restricted || task.wire.createdBy === 'intake')
  ) {
    throw new UsageError(
      `${id} runs as an agent with a fixed list of commands: it may watch with --ci, --pr-review, --pr-merged or --in/--at only`,
    );
  }
  const cwd = ctx.rt.cwd();
  const common = {
    id: newWatchId(),
    name: plan.name,
    task: id,
    createdAt: now.toISOString(),
    deadline: plan.deadline.toISOString(),
  };
  const settings = ctx.startDir === null ? {} : { settingsDir: ctx.startDir };
  const reported = reportedPr(task.prs);
  let def: WatchDef;
  switch (plan.kind) {
    case 'ci': {
      const { url, head } = await resolvePr(ctx, id, '--ci', plan.pr, reported);
      def = {
        ...common,
        source: {
          kind: 'ci',
          pr: url,
          required: plan.required,
          ...(plan.ignore.length > 0 ? { ignore: plan.ignore } : {}),
          head,
          headSince: now.toISOString(),
          cwd,
          ...settings,
        },
        everyMs: CI_EVERY_MS,
      };
      break;
    }
    case 'pr-review': {
      const { url } = await resolvePr(ctx, id, '--pr-review', plan.pr, reported);
      const self = await reviewerLogin(ctx);
      def = {
        ...common,
        source: {
          kind: 'pr-review',
          pr: url,
          ...(self === undefined ? {} : { self }),
          cwd,
          ...settings,
        },
        everyMs: PR_REVIEW_EVERY_MS,
      };
      break;
    }
    case 'pr-merged': {
      const { url } = await resolvePr(ctx, id, '--pr-merged', plan.pr, reported);
      def = {
        ...common,
        source: { kind: 'pr-merged', pr: url, cwd, ...settings },
        everyMs: PR_MERGED_EVERY_MS,
      };
      break;
    }
    case 'command':
      def = {
        ...common,
        source: { kind: 'command', command: plan.command, cwd, ...settings },
        everyMs: plan.everyMs,
      };
      break;
    case 'stream':
      def = {
        ...common,
        source: { kind: 'stream', command: plan.command, cwd, starts: 0, events: 0, ...settings },
        everyMs: 0,
      };
      break;
    case 'timer':
      def = { ...common, source: { kind: 'timer' }, everyMs: 0 };
      break;
  }

  if (ctx.dryRun) {
    ctx.out(`DRY store watch "${def.name}" for ${id} until ${localTime(plan.deadline)}`);
    return;
  }
  const store = new WatchStore(ctx.dirs.state);
  const replaced = store.read(id, def.name) !== undefined;
  store.write(def);
  await publishWatches(s, store, id, (line) => {
    ctx.err(line);
  });
  const until = def.source.kind === 'timer' ? '' : `; until ${localTime(plan.deadline)}`;
  confirm(ctx, `watching "${def.name}" on ${id}: ${summaryOf(def)}${until}`);
  if (def.source.kind === 'ci' && def.source.ignore !== undefined) {
    confirm(ctx, `ignoring ${def.source.ignore.map((pattern) => `"${pattern}"`).join(', ')}`);
  }
  if (replaced) confirm(ctx, `it replaced the open watch "${def.name}"`);
  confirm(ctx, KEEP_WORKING);
}

function describeSource(def: WatchDef): string {
  const { source } = def;
  switch (source.kind) {
    case 'timer':
      return 'timer';
    case 'ci':
      return `ci ${source.pr}${source.required ? ' (required checks)' : ''}${
        source.ignore === undefined || source.ignore.length === 0
          ? ''
          : ` (ignoring ${source.ignore.map((pattern) => `"${pattern}"`).join(', ')})`
      }`;
    case 'stream':
      return `stream: ${oneLine(source.command, 80)}`;
    case 'pr-review':
      return `reviews and comments of ${source.pr}`;
    case 'pr-merged':
      return `merge of ${source.pr}`;
    case 'command':
      return `every ${formatDuration(def.everyMs)}: ${oneLine(source.command, 80)}`;
  }
}

function lastLine(def: WatchDef): string {
  const { source, last } = def;
  if (source.kind === 'stream') {
    return last === undefined || source.starts === 0
      ? 'not started yet'
      : `${source.events} events, ${last.summary} ${localTime(new Date(last.at))}`;
  }
  return last === undefined
    ? 'not looked at yet'
    : `last looked at ${localTime(new Date(last.at))}: ${oneLine(last.summary, 200)}`;
}

function watchJson(def: WatchDef): Record<string, unknown> {
  const { source } = def;
  return {
    name: def.name,
    source:
      source.kind === 'ci'
        ? { kind: 'ci', pr: source.pr, required: source.required, ignore: source.ignore ?? [] }
        : source.kind === 'stream'
          ? {
              kind: 'stream',
              command: source.command,
              starts: source.starts,
              events: source.events,
            }
          : source.kind === 'timer'
            ? { kind: 'timer' }
            : source.kind === 'command'
              ? { kind: 'command', command: source.command }
              : { kind: source.kind, pr: source.pr },
    everyMs: def.everyMs,
    createdAt: def.createdAt,
    deadline: def.deadline,
    last: def.last ?? null,
  };
}

export async function runWatches(
  ctx: Context,
  input: string,
  options: { json?: boolean },
): Promise<void> {
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  requireOwnTask(ctx, id);
  await requireHere(s, id, 'its watches');
  const store = new WatchStore(ctx.dirs.state);
  const { defs, unreadable } = store.list(id);
  if (options.json === true) {
    ctx.out(JSON.stringify(defs.map(watchJson)));
    return;
  }
  const undelivered = store.events(id).length;
  const lines =
    defs.length === 0
      ? [`${id} has no open watch`]
      : defs.flatMap((def) => [
          `${def.name}  ${describeSource(def)}`,
          `  until ${localTime(new Date(def.deadline))}; ${lastLine(def)}`,
        ]);
  if (undelivered > 0) {
    lines.push(`${undelivered} event${undelivered > 1 ? 's' : ''} not handed to the agent yet`);
  }
  if (unreadable.length > 0) {
    lines.push(
      `${unreadable.length} watch file${unreadable.length > 1 ? 's' : ''} could not be read`,
    );
  }
  for (const line of lines) ctx.out(plain(line));
}

export async function runUnwatch(ctx: Context, input: string, name: string): Promise<void> {
  const s = await session(ctx);
  const id = await resolveTask(ctx, s, input);
  requireOwnTask(ctx, id);
  await requireHere(s, id, 'its watches');
  checkedName(name);
  if (ctx.dryRun) {
    ctx.out(`DRY stop watch "${name}" on ${id}`);
    return;
  }
  const store = new WatchStore(ctx.dirs.state);
  const claim = store.claim(id, name);
  if (claim === undefined) {
    const open = store.list(id).defs.map((def) => `"${def.name}"`);
    throw new UsageError(
      open.length === 0
        ? `${id} has no open watch`
        : `${id} has no watch "${name}"; open: ${open.join(', ')}`,
    );
  }
  claim.done();
  await publishWatches(s, store, id, (line) => {
    ctx.err(line);
  });
  confirm(ctx, `stopped watch "${name}" on ${id}`);
}
