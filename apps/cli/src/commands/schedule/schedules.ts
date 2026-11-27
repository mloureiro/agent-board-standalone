import {
  editScheduleRoute,
  listSchedulesRoute,
  removeScheduleRoute,
  updateScheduleRoute,
  type ScheduleSettings,
  type WireSchedule,
} from '@rumo/contract';
import { bindings, seal } from '@rumo/sealing';

import { isAgentName } from '../../agents/definition.js';
import {
  checkedIcon,
  checkedLabels,
  checkedLane,
  checkedModel,
  checkedSize,
  parseEffort,
  parsePriority,
  plain,
} from '../../domain/rules.js';
import { localTime, parseDuration, parseStart } from '../../domain/time.js';
import { UsageError } from '../../errors.js';
import { readLocalDirectories, normalizePath, syncDirectories } from '../../directories/index.js';
import { readNoteFile } from '../../input/note-file.js';
import {
  checkedAfter,
  checkedCrons,
  checkedEvery,
  checkedMaxConcurrent,
  checkedTimes,
} from '../../scheduling/args.js';
import { describeRepeat } from '../../scheduling/describe.js';
import { openSchedule, type OpenSchedule } from '../../scheduling/open.js';
import type { Session } from '../../transport/session.js';
import type { Context } from '../context.js';
import { confirm, refuseInRun, session } from '../tasks/support.js';
import path from 'node:path';

export interface SchedulesOptions {
  readonly json?: boolean;
  readonly title?: string;
  readonly file?: string;
  readonly priority?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly icon?: string;
  readonly label?: string[];
  readonly lane?: string;
  readonly autoDone?: string;
  readonly agent?: string;
  readonly dir?: string;
  readonly every?: string;
  readonly cron?: string[];
  readonly after?: string;
  readonly delay?: string;
  readonly in?: string;
  readonly at?: string;
  readonly times?: string;
  readonly until?: string;
  readonly forever?: boolean;
  readonly maxConcurrent?: string;
}

const EDIT_FLAGS = [
  'title',
  'file',
  'priority',
  'model',
  'effort',
  'icon',
  'label',
  'lane',
  'autoDone',
  'agent',
  'dir',
  'every',
  'cron',
  'after',
  'delay',
  'in',
  'at',
  'times',
  'until',
  'forever',
  'maxConcurrent',
] as const;

async function resolveSchedule(
  s: Session,
  given: string,
): Promise<{ wire: WireSchedule; all: WireSchedule[] }> {
  const { schedules } = await s.query(listSchedulesRoute, {});
  const exact = schedules.find((schedule) => schedule.id === given);
  const matches =
    exact === undefined ? schedules.filter((schedule) => schedule.id.startsWith(given)) : [exact];
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { wire: only, all: schedules };
  throw new UsageError(
    matches.length === 0
      ? `no schedule "${plain(given).slice(0, 40)}"`
      : `"${plain(given).slice(0, 40)}" starts ${matches.length} schedules; give more of the id`,
  );
}

function state(wire: WireSchedule): string {
  if (wire.ended) return 'ended';
  if (wire.paused) return 'paused';
  return wire.nextRunAt === null
    ? 'waits for its predecessor'
    : `next ${localTime(new Date(wire.nextRunAt))}`;
}

function shape(wire: WireSchedule) {
  return {
    everyMs: wire.everyMs,
    crons: wire.cron === null ? [] : [wire.cron, ...(wire.moreCrons ?? [])],
    after:
      wire.after === null
        ? null
        : { scheduleId: wire.after.scheduleId, delayMs: wire.after.delayMs },
  };
}

async function runList(ctx: Context, options: SchedulesOptions): Promise<void> {
  const s = await session(ctx);
  s.require('schedules');
  const { schedules } = await s.query(listSchedulesRoute, {});
  const opened = await Promise.all(schedules.map((wire) => openSchedule(s.keys, wire)));
  if (options.json === true) {
    ctx.out(
      JSON.stringify(
        opened.map((entry) => ({
          id: entry.wire.id,
          title: entry.title,
          rule: describeRepeat(shape(entry.wire)),
          machine: entry.wire.machine,
          projectId: entry.wire.projectId,
          directoryId: entry.wire.directoryId,
          paused: entry.wire.paused,
          ended: entry.wire.ended,
          nextRunAt: entry.wire.nextRunAt,
          remaining: entry.wire.remaining,
          until: entry.wire.until,
        })),
      ),
    );
    return;
  }
  if (opened.length === 0)
    ctx.out('no schedules; create one with "rumo schedule --every 1d <prompt>"');
  const width = Math.max(...opened.map((entry) => entry.wire.id.length), 0);
  for (const entry of opened) {
    const { wire } = entry;
    const limit = [
      wire.remaining === null ? undefined : `${wire.remaining} runs left`,
      wire.until === null ? undefined : `until ${localTime(new Date(wire.until))}`,
      wire.maxConcurrent === null ? undefined : `at most ${wire.maxConcurrent} at once`,
    ].filter((part) => part !== undefined);
    ctx.out(
      `${wire.id.padEnd(width)}  ${describeRepeat(shape(wire))}  ${state(wire)}${
        limit.length === 0 ? '' : ` (${limit.join(', ')})`
      }  ${entry.title === null ? '(cannot decrypt)' : plain(entry.title)}`,
    );
  }
}

async function changeSettings(
  ctx: Context,
  s: Session,
  current: OpenSchedule,
  options: SchedulesOptions,
  now: Date,
): Promise<ScheduleSettings | undefined> {
  const { wire } = current;
  const touched = EDIT_FLAGS.filter(
    (flag) => !['title', 'file'].includes(flag) && options[flag] !== undefined,
  );
  if (touched.length === 0) return undefined;

  const crons = options.cron === undefined ? undefined : checkedCrons(options.cron);
  const repeatFlags = [
    options.every !== undefined,
    crons !== undefined,
    options.after !== undefined,
  ];
  if (repeatFlags.filter(Boolean).length > 1) {
    throw new UsageError('--every, --cron and --after replace the repeat: give one of them');
  }
  if (options.delay !== undefined && options.after === undefined) {
    throw new UsageError('--delay belongs to --after');
  }
  if (options.in !== undefined && options.at !== undefined) {
    throw new UsageError('--in and --at cannot be combined');
  }
  if (options.times !== undefined && (options.until !== undefined || options.forever === true)) {
    throw new UsageError('--times, --until and --forever are one choice');
  }
  if (options.until !== undefined && options.forever === true) {
    throw new UsageError('--times, --until and --forever are one choice');
  }

  const repeat: ScheduleSettings['repeat'] =
    options.every !== undefined
      ? { everyMs: checkedEvery(options.every) }
      : crons !== undefined && crons[0] !== undefined
        ? {
            cron: crons[0],
            ...(crons.length > 1 ? { moreCrons: crons.slice(1) } : {}),
            timezone: ctx.rt.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        : options.after !== undefined
          ? {
              after: {
                scheduleId: await resolveAfterId(s, options.after, wire.id),
                delayMs: options.delay === undefined ? 0 : parseDuration(options.delay),
              },
            }
          : wire.everyMs !== null
            ? { everyMs: wire.everyMs }
            : wire.cron !== null && wire.timezone !== null
              ? {
                  cron: wire.cron,
                  ...(wire.moreCrons === undefined || wire.moreCrons.length === 0
                    ? {}
                    : { moreCrons: wire.moreCrons }),
                  timezone: wire.timezone,
                }
              : {
                  after: {
                    scheduleId: wire.after?.scheduleId ?? '',
                    delayMs:
                      options.delay === undefined
                        ? (wire.after?.delayMs ?? 0)
                        : parseDuration(options.delay),
                  },
                };
  if ('after' in repeat && options.delay !== undefined && options.after === undefined) {
    repeat.after = { ...repeat.after, delayMs: parseDuration(options.delay) };
  }

  const start = parseStart({ in: options.in, at: options.at }, now);
  let place: ScheduleSettings['place'] =
    wire.machine !== null && wire.directoryId !== null
      ? { machine: wire.machine, directoryId: wire.directoryId }
      : null;
  if (options.dir !== undefined) {
    if (options.dir === 'none') place = null;
    else {
      const target = normalizePath(path.resolve(ctx.rt.cwd(), options.dir));
      const { rows } = await syncDirectories(s, { configDir: ctx.dirs.config, say: ctx.err });
      const row = rows.find((candidate) => normalizePath(candidate.path) === target);
      const listed = readLocalDirectories(ctx.dirs.config).entries.some(
        (entry) => normalizePath(entry.path) === target,
      );
      if (row === undefined || !listed) {
        throw new UsageError(
          `${plain(target)} is not a listed directory of this machine; run "rumo dirs add" first`,
        );
      }
      place = { machine: s.machine, directoryId: row.id };
    }
  }

  let labels = wire.labels ?? null;
  if (options.label !== undefined) {
    const asked =
      options.label.length === 1 && options.label[0] === 'none' ? [] : checkedLabels(options.label);
    labels =
      asked.length === 0
        ? null
        : await seal(s.keys, bindings.labels({ schedule: wire.id }), JSON.stringify(asked));
  }
  let icon = wire.icon ?? null;
  if (options.icon !== undefined) {
    icon =
      options.icon === 'none'
        ? null
        : await seal(s.keys, bindings.icon({ schedule: wire.id }), checkedIcon(options.icon));
  }

  const settings: ScheduleSettings = {
    place,
    priority: options.priority === undefined ? wire.priority : parsePriority(options.priority),
    model:
      options.model === undefined
        ? wire.model
        : options.model === 'default'
          ? null
          : checkedModel(options.model),
    effort:
      options.effort === undefined
        ? wire.effort
        : options.effort === 'default'
          ? null
          : parseEffort(options.effort),
    lane:
      options.lane === undefined
        ? wire.requestedLane
        : options.lane === 'default'
          ? null
          : checkedLane(options.lane),
    icon,
    labels,
    autoDone: options.autoDone === undefined ? wire.autoDone : onOff(options.autoDone),
    repeat,
    runsLeft:
      options.times !== undefined
        ? checkedTimes(options.times)
        : options.until !== undefined || options.forever === true
          ? null
          : wire.remaining,
    until:
      options.until !== undefined
        ? (parseStart({ at: options.until }, now) ?? now).toISOString()
        : options.times !== undefined || options.forever === true
          ? null
          : wire.until,
    maxConcurrent:
      options.maxConcurrent === undefined
        ? wire.maxConcurrent
        : options.maxConcurrent === 'none'
          ? null
          : checkedMaxConcurrent(options.maxConcurrent),
    ...(start === undefined ? {} : { at: start.toISOString() }),
  };
  if (options.agent !== undefined) {
    if (options.agent !== 'none' && !isAgentName(options.agent)) {
      throw new UsageError(`"${options.agent.slice(0, 40)}" is not an agent name`);
    }
    if (options.agent !== 'none') {
      settings.agent = await seal(s.keys, bindings.agent({ schedule: wire.id }), options.agent);
    }
  } else if (wire.agent !== null && wire.agent !== undefined) {
    settings.agent = wire.agent;
  }
  return settings;
}

function onOff(value: string): boolean {
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new UsageError('--auto-done takes on or off');
}

async function resolveAfterId(s: Session, given: string, own: string): Promise<string> {
  checkedAfter(given);
  const { schedules } = await s.query(listSchedulesRoute, {});
  const matches = schedules.filter(
    (schedule) => schedule.id === given || schedule.id.startsWith(given),
  );
  const [only] = matches;
  if (matches.length !== 1 || only === undefined) {
    throw new UsageError(`"${given.slice(0, 40)}" does not name exactly one schedule`);
  }
  if (only.id === own) throw new UsageError('a schedule cannot run after itself');
  return only.id;
}

async function runEdit(
  ctx: Context,
  given: string,
  words: readonly string[],
  options: SchedulesOptions,
): Promise<void> {
  const s = await session(ctx);
  s.require('schedules');
  const { wire } = await resolveSchedule(s, given);
  const current = await openSchedule(s.keys, wire);
  let text: string | undefined;
  if (options.file !== undefined) {
    if (words.length > 0)
      throw new UsageError('give the new prompt as text or with --file, not both');
    text = readNoteFile(options.file, ctx.rt.platform);
  } else if (words.length === 1 && words[0] === '-') text = (await ctx.rt.readStdin()).trim();
  else if (words.length > 0) text = words.join(' ').trim();
  if (text === '') throw new UsageError('the new prompt is empty');

  const title = options.title?.trim() ?? current.title;
  const input = text ?? current.input;
  if (title === null || input === null) {
    throw new UsageError(
      `${wire.id} has a title or prompt this machine cannot decrypt: give both with --title and a new prompt`,
    );
  }
  checkedSize('title', title, 'the title');
  checkedSize('input', input, 'the prompt');
  const settings = await changeSettings(ctx, s, current, options, new Date());
  const agent =
    settings === undefined
      ? current.agent
      : options.agent === undefined
        ? current.agent
        : options.agent === 'none'
          ? null
          : options.agent;
  const answer = await s.command(editScheduleRoute, {
    id: wire.id,
    title: await seal(s.keys, bindings.title({ schedule: wire.id }), title),
    input: await seal(
      s.keys,
      bindings.input({ origin: { schedule: wire.id }, creator: 'user', agent }),
      input,
    ),
    ...(settings === undefined ? {} : { settings }),
  });
  confirm(
    ctx,
    `edited ${wire.id}${answer === null || answer.pending === 'none' ? '' : `; its pending task was ${answer.pending}`}`,
  );
}

export async function runSchedules(
  ctx: Context,
  action: readonly string[],
  options: SchedulesOptions,
): Promise<void> {
  const [verb = 'list', ...rest] = action;
  if (verb === 'list') {
    if (rest.length > 0) throw new UsageError('rumo schedules list takes no arguments');
    await runList(ctx, options);
    return;
  }
  refuseInRun(ctx, `rumo schedules ${verb}`);
  const [given, ...more] = rest;
  if (given === undefined) throw new UsageError(`usage: rumo schedules ${verb} <id>`);
  if (verb === 'edit') {
    await runEdit(ctx, given, more, options);
    return;
  }
  if (more.length > 0) throw new UsageError(`usage: rumo schedules ${verb} <id>`);
  const touched = EDIT_FLAGS.filter((flag) => options[flag] !== undefined);
  if (touched.length > 0)
    throw new UsageError(`--${touched[0] ?? ''} belongs to rumo schedules edit`);
  if (verb !== 'pause' && verb !== 'resume' && verb !== 'rm') {
    throw new UsageError(
      `unknown action "${plain(verb).slice(0, 40)}"; use list, pause, resume, rm or edit`,
    );
  }
  const s = await session(ctx);
  s.require('schedules');
  const { wire } = await resolveSchedule(s, given);
  if (verb === 'rm') {
    await s.command(removeScheduleRoute, { id: wire.id });
    confirm(ctx, `removed ${wire.id}`);
    return;
  }
  await s.command(updateScheduleRoute, { id: wire.id, paused: verb === 'pause' });
  confirm(ctx, `${verb === 'pause' ? 'paused' : 'resumed'} ${wire.id}`);
}
