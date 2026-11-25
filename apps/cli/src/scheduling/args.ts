import {
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
  MAX_SCHEDULE_TIMES,
  MIN_INTERVAL_MS,
  scheduleId,
} from '@agent-board/contract';

import { UsageError } from '../errors.js';
import { checkedModel, checkedSize, parseEffort, parsePriority } from '../domain/rules.js';
import { formatDuration, parseDuration, parseStart } from '../domain/time.js';

export interface ScheduleFlags {
  priority?: string;
  model?: string;
  effort?: string;
  icon?: string;
  label?: string[];
  lane?: string;
  autoDone?: boolean;
  agent?: string;
  title?: string;
  hold?: boolean;
  backlog?: boolean;
  new?: boolean;
  polish?: boolean;
  in?: string;
  at?: string;
  every?: string;
  cron?: string[];
  after?: string;
  delay?: string;
  maxConcurrent?: string;
  times?: string;
  until?: string;
  key?: string;
  version?: string;
  json?: boolean;
}

export interface ScheduleArgs {
  readonly prompt: string;
  readonly title: string | undefined;
  readonly priority: ReturnType<typeof parsePriority> | undefined;
  readonly model: string | undefined;
  readonly effort: ReturnType<typeof parseEffort> | undefined;
  readonly icon: string | undefined;
  readonly labels: readonly string[] | undefined;
  readonly lane: string | undefined;
  readonly autoDone: boolean;
  readonly agent: string | undefined;
  readonly hold: boolean;
  readonly backlog: boolean;
  readonly notBefore: Date | undefined;
  readonly everyMs: number | undefined;
  readonly crons: readonly string[];
  readonly after: string | undefined;
  readonly delayMs: number | undefined;
  readonly maxConcurrent: number | undefined;
  readonly times: number | undefined;
  readonly until: Date | undefined;
  readonly polish: boolean;
  readonly key: string | undefined;
  readonly version: string | undefined;
  readonly json: boolean;
}

export const KEY_MAX = 500;
const VERSION_MAX = 200;

export function checkedCrons(crons: readonly string[]): string[] {
  const trimmed = crons.map((expression) => expression.trim().split(/\s+/).join(' '));
  for (const expression of trimmed) {
    if (expression.split(' ').length !== 5) {
      throw new UsageError(
        `--cron takes 5 fields (minute hour day month weekday), such as "0 9 * * 1-5"; got "${expression.slice(0, 60)}"`,
      );
    }
  }
  if (trimmed.length > MAX_SCHEDULE_CRONS) {
    throw new UsageError(`--cron can be given at most ${MAX_SCHEDULE_CRONS} times`);
  }
  const repeated = trimmed.find((expression, index) => trimmed.indexOf(expression) !== index);
  if (repeated !== undefined)
    throw new UsageError(`--cron "${repeated.slice(0, 60)}" is given twice`);
  return trimmed;
}

export function checkedEvery(text: string): number {
  const ms = parseDuration(text);
  if (ms < MIN_INTERVAL_MS) {
    throw new UsageError(`a repeat must be at least ${formatDuration(MIN_INTERVAL_MS)}`);
  }
  return ms;
}

export function checkedMaxConcurrent(text: string): number {
  const limit = Number(text);
  if (!/^[1-9]\d{0,2}$/.test(text) || limit > MAX_SCHEDULE_CONCURRENT) {
    throw new UsageError(
      `--max-concurrent takes a whole number from 1 to ${MAX_SCHEDULE_CONCURRENT}; got "${text.slice(0, 20)}"`,
    );
  }
  return limit;
}

export function checkedTimes(text: string): number {
  const count = Number(text);
  if (!/^[1-9]\d{0,9}$/.test(text) || count > MAX_SCHEDULE_TIMES) {
    throw new UsageError(`--times takes a positive whole number; got "${text.slice(0, 20)}"`);
  }
  return count;
}

export function checkedAfter(value: string): string {
  if (!scheduleId.safeParse(value).success && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new UsageError(
      `--after takes the id of a schedule or the start of it; got "${value.slice(0, 40)}"`,
    );
  }
  return value;
}

function checkedText(flag: string, value: string, max: number): string {
  if (value.trim() === '') throw new UsageError(`${flag} must not be empty`);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new UsageError(`${flag} must not contain control characters`);
  }
  if (value.length > max) throw new UsageError(`${flag} is longer than ${max} characters`);
  return value;
}

function conflicts(flag: string, why: string, others: readonly (string | false)[]): void {
  const found = others.filter((other) => other !== false);
  if (found.length > 0)
    throw new UsageError(`${flag} ${why}; it cannot be combined with ${found.join(', ')}`);
}

export function parseScheduleArgs(
  flags: ScheduleFlags,
  words: readonly string[],
  now: Date,
): ScheduleArgs {
  if (words.at(-1) === '--dry-run') {
    throw new UsageError(
      'the prompt ends in --dry-run; put the flag before the prompt, or start the prompt with --',
    );
  }
  const hold = flags.hold === true;
  const polish = flags.polish === true;
  const backlog = flags.backlog === true || polish;
  const crons = checkedCrons(flags.cron ?? []);
  const hasCron = crons.length > 0;
  const { in: delay, at, every, times, until } = flags;
  const hasAfter = flags.after !== undefined;

  if (hasAfter) {
    conflicts('--after', 'makes a schedule that waits for another one', [
      every !== undefined && '--every',
      hasCron && '--cron',
      delay !== undefined && '--in',
      at !== undefined && '--at',
      hold && '--hold',
      flags.backlog === true && '--backlog',
      flags.key !== undefined && '--key',
      polish && '--polish',
    ]);
  }
  if (flags.delay !== undefined && !hasAfter) throw new UsageError('--delay belongs to --after');
  if (polish) {
    conflicts('--polish', 'parks the task in Backlog, where its polished prompt is applied', [
      hold && '--hold',
      delay !== undefined && '--in',
      at !== undefined && '--at',
      every !== undefined && '--every',
      hasCron && '--cron',
      times !== undefined && '--times',
      until !== undefined && '--until',
    ]);
  }
  if (hold && backlog) throw new UsageError('--hold and --backlog cannot be combined');
  if (delay !== undefined && at !== undefined)
    throw new UsageError('--in and --at cannot be combined');
  if ((delay !== undefined || at !== undefined) && (hold || backlog)) {
    throw new UsageError(
      '--in and --at queue the task in Todo; they cannot be combined with --hold or --backlog',
    );
  }
  if (every !== undefined && hasCron) throw new UsageError('--every and --cron cannot be combined');
  const repeats = every !== undefined || hasCron || hasAfter;
  if (!repeats && (times !== undefined || until !== undefined)) {
    throw new UsageError('--times and --until end a repeat; add --every, --cron or --after');
  }
  if (!repeats && flags.maxConcurrent !== undefined) {
    throw new UsageError('--max-concurrent limits a repeat; add --every, --cron or --after');
  }
  if (repeats && (hold || backlog)) {
    throw new UsageError(
      'a repeat queues its tasks in Todo; it cannot be combined with --hold or --backlog',
    );
  }
  if (times !== undefined && until !== undefined) {
    throw new UsageError('--times and --until cannot be combined');
  }
  if (flags.key !== undefined) {
    conflicts('--key', 'makes or finds one task in Todo, and requeues it into Todo', [
      every !== undefined && '--every',
      hasCron && '--cron',
      polish && '--polish',
      hold && '--hold',
      flags.backlog === true && '--backlog',
    ]);
  } else if (flags.version !== undefined) {
    throw new UsageError('--version belongs to --key: add --key');
  }

  const notBefore = parseStart({ in: delay, at }, now);
  const untilDate = parseStart({ at: until }, now);
  if (untilDate !== undefined && untilDate.getTime() < (notBefore ?? now).getTime()) {
    throw new UsageError('--until is before the first run');
  }
  const prompt = words.join(' ').trim();
  if (prompt === '') throw new UsageError('a prompt is required');
  checkedSize('input', prompt, 'the prompt');

  return {
    prompt,
    title: flags.title?.trim() === '' ? undefined : flags.title?.trim(),
    priority: flags.priority === undefined ? undefined : parsePriority(flags.priority),
    model: flags.model === undefined ? undefined : checkedModel(flags.model),
    effort: flags.effort === undefined ? undefined : parseEffort(flags.effort),
    icon: flags.icon,
    labels: flags.label,
    lane: flags.lane,
    autoDone: flags.autoDone === true,
    agent: flags.agent,
    hold,
    backlog,
    notBefore,
    everyMs: every === undefined ? undefined : checkedEvery(every),
    crons,
    after: flags.after === undefined ? undefined : checkedAfter(flags.after),
    delayMs: flags.delay === undefined ? undefined : parseDuration(flags.delay),
    maxConcurrent:
      flags.maxConcurrent === undefined ? undefined : checkedMaxConcurrent(flags.maxConcurrent),
    times: times === undefined ? undefined : checkedTimes(times),
    until: untilDate,
    polish,
    key: flags.key === undefined ? undefined : checkedText('--key', flags.key, KEY_MAX),
    version:
      flags.version === undefined
        ? undefined
        : checkedText('--version', flags.version, VERSION_MAX),
    json: flags.json === true,
  };
}

export function defaultTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? prompt;
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > 100 ? `${flat.slice(0, 99)}…` : flat;
}
