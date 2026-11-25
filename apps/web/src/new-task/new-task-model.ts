import {
  EFFORTS,
  MAX_INTERVAL_MS,
  MAX_SCHEDULE_CONCURRENT,
  MAX_SCHEDULE_CRONS,
  MIN_INTERVAL_MS,
  PRIORITIES,
  agentName,
  laneName,
  type Effort,
  type Priority,
  type UiTaskCreate,
} from '@agent-board/contract';
import { bindings, seal, type Keys } from '@agent-board/sealing';

import { sealPromptAsUser, serializeLabels } from '../routes/board/card-model.js';

export const WHEN_KINDS = ['now', 'later', 'repeating', 'backlog', 'needs-me'] as const;
export type WhenKind = (typeof WHEN_KINDS)[number];

export const WHEN_LABELS: Record<WhenKind, string> = {
  now: 'Now',
  later: 'Later',
  repeating: 'Repeating',
  backlog: 'Backlog',
  'needs-me': 'Needs me',
};

export const REPEAT_KINDS = ['interval', 'crons', 'after'] as const;
export type RepeatKind = (typeof REPEAT_KINDS)[number];

export const INTERVAL_UNITS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;
export type IntervalUnit = keyof typeof INTERVAL_UNITS;

export const TITLE_FROM_PROMPT_LENGTH = 80;

export interface NewTaskForm {
  readonly prompt: string;
  readonly title: string;
  readonly projectId: string;
  readonly icon: string;
  readonly directoryId: string | null;
  readonly machine: string;
  readonly labels: string;
  readonly priority: Priority;
  readonly model: string;
  readonly effort: Effort | '';
  readonly lane: string;
  readonly agent: string;
  readonly autoDone: boolean;
  readonly when: WhenKind;
  readonly startAt: string;
  readonly repeat: RepeatKind;
  readonly every: string;
  readonly everyUnit: IntervalUnit;
  readonly crons: string;
  readonly timezone: string;
  readonly afterId: string;
  readonly afterDelay: string;
  readonly runs: string;
  readonly atMost: string;
}

export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

export const emptyForm = (timezone: string = browserTimezone()): NewTaskForm => ({
  prompt: '',
  title: '',
  projectId: '',
  icon: '',
  directoryId: null,
  machine: '',
  labels: '',
  priority: 'normal',
  model: '',
  effort: '',
  lane: '',
  agent: '',
  autoDone: false,
  when: 'now',
  startAt: '',
  repeat: 'interval',
  every: '1',
  everyUnit: 'hours',
  crons: '',
  timezone,
  afterId: '',
  afterDelay: '0',
  runs: '',
  atMost: '',
});

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

export function restoreForm(raw: string | null, fallback: NewTaskForm = emptyForm()): NewTaskForm {
  if (raw === null) return fallback;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
    parsed = value as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const text = (key: keyof NewTaskForm): string => {
    const value = parsed[key];
    return typeof value === 'string' ? value : (fallback[key] as string);
  };
  return {
    prompt: text('prompt'),
    title: text('title'),
    projectId: text('projectId'),
    icon: text('icon'),
    directoryId: typeof parsed.directoryId === 'string' ? parsed.directoryId : null,
    machine: text('machine'),
    labels: text('labels'),
    priority: isOneOf(PRIORITIES, parsed.priority) ? parsed.priority : fallback.priority,
    model: text('model'),
    effort: parsed.effort === '' || isOneOf(EFFORTS, parsed.effort) ? parsed.effort : '',
    lane: text('lane'),
    agent: text('agent'),
    autoDone: parsed.autoDone === true,
    when: isOneOf(WHEN_KINDS, parsed.when) ? parsed.when : fallback.when,
    startAt: text('startAt'),
    repeat: isOneOf(REPEAT_KINDS, parsed.repeat) ? parsed.repeat : fallback.repeat,
    every: text('every'),
    everyUnit: isOneOf(Object.keys(INTERVAL_UNITS) as IntervalUnit[], parsed.everyUnit)
      ? parsed.everyUnit
      : fallback.everyUnit,
    crons: text('crons'),
    timezone: text('timezone'),
    afterId: text('afterId'),
    afterDelay: text('afterDelay'),
    runs: text('runs'),
    atMost: text('atMost'),
  };
}

export const isBlankForm = (form: NewTaskForm, fallback: NewTaskForm = emptyForm()): boolean =>
  JSON.stringify(form) === JSON.stringify(fallback);

export const splitLabels = (text: string): string[] =>
  text
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');

export const titleFromPrompt = (prompt: string): string => {
  const line = prompt.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.trim().slice(0, TITLE_FROM_PROMPT_LENGTH);
};

const wholeNumber = (text: string): number | null => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
};

const localTime = (text: string): string | null => {
  if (text === '') return null;
  const time = new Date(text);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
};

export interface FormProblems {
  readonly lane?: string;
  readonly agent?: string;
  readonly startAt?: string;
  readonly every?: string;
  readonly crons?: string;
  readonly timezone?: string;
  readonly afterId?: string;
  readonly afterDelay?: string;
  readonly runs?: string;
  readonly atMost?: string;
}

export type WhenResult =
  | { readonly ok: true; readonly when: UiTaskCreate['when'] }
  | { readonly ok: false; readonly problems: FormProblems };

export const splitCrons = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function buildWhen(form: NewTaskForm): WhenResult {
  if (form.when === 'now') return { ok: true, when: 'now' };
  if (form.when === 'backlog') return { ok: true, when: 'backlog' };
  if (form.when === 'needs-me') return { ok: true, when: 'hold' };

  const start = localTime(form.startAt);
  if (form.when === 'later') {
    return start === null
      ? { ok: false, problems: { startAt: 'Pick when the task should start' } }
      : { ok: true, when: { at: start } };
  }

  const problems: { -readonly [K in keyof FormProblems]: FormProblems[K] } = {};
  const times = form.runs.trim() === '' ? null : wholeNumber(form.runs);
  if (form.runs.trim() !== '' && (times === null || times < 1)) {
    problems.runs = 'Runs is a whole number of at least 1';
  }
  const atMost = form.atMost.trim() === '' ? null : wholeNumber(form.atMost);
  if (
    form.atMost.trim() !== '' &&
    (atMost === null || atMost < 1 || atMost > MAX_SCHEDULE_CONCURRENT)
  ) {
    problems.atMost = `At most is between 1 and ${MAX_SCHEDULE_CONCURRENT}`;
  }
  if (form.startAt !== '' && start === null) problems.startAt = 'The start time is not valid';
  const common = {
    ...(times === null ? {} : { times }),
    ...(atMost === null ? {} : { maxConcurrent: atMost }),
  };

  if (form.repeat === 'interval') {
    const count = wholeNumber(form.every);
    const every = count === null ? null : count * INTERVAL_UNITS[form.everyUnit];
    if (every === null || every < MIN_INTERVAL_MS || every > MAX_INTERVAL_MS) {
      problems.every = 'The interval is at least one minute and at most ten years';
    }
    if (Object.keys(problems).length > 0 || every === null) return { ok: false, problems };
    return {
      ok: true,
      when: { every, ...(start === null ? {} : { at: start }), ...common },
    };
  }

  if (form.repeat === 'crons') {
    const [first, ...more] = splitCrons(form.crons);
    if (first === undefined) problems.crons = 'Write at least one cron expression';
    if (more.length + 1 > MAX_SCHEDULE_CRONS) {
      problems.crons = `At most ${MAX_SCHEDULE_CRONS} crons`;
    }
    if (form.timezone.trim() === '') problems.timezone = 'Write a timezone';
    if (Object.keys(problems).length > 0 || first === undefined) return { ok: false, problems };
    return {
      ok: true,
      when: {
        cron: first,
        timezone: form.timezone.trim(),
        ...(more.length === 0 ? {} : { moreCrons: more }),
        ...(start === null ? {} : { at: start }),
        ...common,
      },
    };
  }

  if (form.afterId === '') problems.afterId = 'Pick the schedule to run after';
  const delay = form.afterDelay.trim() === '' ? 0 : wholeNumber(form.afterDelay);
  if (delay === null) problems.afterDelay = 'The delay is a whole number of minutes';
  if (Object.keys(problems).length > 0 || delay === null) return { ok: false, problems };
  return {
    ok: true,
    when: { after: { scheduleId: form.afterId, delayMs: delay * 60_000 }, ...common },
  };
}

export function formProblems(form: NewTaskForm): FormProblems {
  const problems: { -readonly [K in keyof FormProblems]: FormProblems[K] } = {};
  if (form.lane !== '' && !laneName.safeParse(form.lane).success) {
    problems.lane = 'Letters, digits, dot, dash and underscore; up to 64 characters';
  }
  if (form.agent !== '' && !agentName.safeParse(form.agent).success) {
    problems.agent = 'Lowercase letters, digits and dashes; up to 32 characters';
  }
  const when = buildWhen(form);
  return when.ok ? problems : { ...problems, ...when.problems };
}

export interface CreateContext {
  readonly id: string;
  readonly machine: string | null;
}

export async function buildCreate(
  keys: Keys,
  form: NewTaskForm,
  context: CreateContext,
): Promise<UiTaskCreate> {
  const { id } = context;
  const when = buildWhen(form);
  if (!when.ok) throw new Error('The When options are not valid.');
  const agent = form.agent.trim() === '' ? null : form.agent.trim();
  const directoryId =
    form.directoryId === null || form.directoryId === '' ? null : form.directoryId;
  const title = form.title.trim() === '' ? titleFromPrompt(form.prompt) : form.title.trim();
  const icon = form.icon.trim();
  const labels = splitLabels(form.labels);
  return {
    id,
    title: await seal(keys, bindings.title({ task: id }), title),
    input: await sealPromptAsUser(keys, id, { forkOf: null, agent, directoryId }, form.prompt),
    priority: form.priority,
    ...(form.model === '' ? {} : { model: form.model }),
    ...(form.effort === '' ? {} : { effort: form.effort }),
    ...(form.lane.trim() === '' ? {} : { lane: form.lane.trim() }),
    ...(form.autoDone ? { autoDone: true } : {}),
    ...(form.projectId === '' ? {} : { projectId: form.projectId }),
    when: when.when,
    ...(directoryId === null || context.machine === null
      ? {}
      : { place: { machine: context.machine, directoryId } }),
    ...(agent === null ? {} : { agent: await seal(keys, bindings.agent({ task: id }), agent) }),
    ...(icon === '' ? {} : { icon: await seal(keys, bindings.icon({ task: id }), icon) }),
    ...(labels.length === 0
      ? {}
      : { labels: await seal(keys, bindings.labels({ task: id }), serializeLabels(labels)) }),
  };
}

export interface Remembered {
  readonly machine: string;
  readonly directoryId: string;
}

export interface PlaceInput {
  readonly form: Pick<NewTaskForm, 'directoryId' | 'machine'>;
  readonly remembered: Remembered | null;
  readonly directories: readonly string[];
  readonly machines: readonly string[];
  readonly directoriesKnown?: boolean;
}

export interface ResolvedPlace {
  readonly directoryId: string;
  readonly machine: string | null;
  readonly staleRemembered: boolean;
}

export function resolvePlace(input: PlaceInput): ResolvedPlace {
  const { form, remembered, directories, machines } = input;
  const usable =
    remembered !== null &&
    machines.includes(remembered.machine) &&
    directories.includes(remembered.directoryId);
  const machine = machines.includes(form.machine)
    ? form.machine
    : usable
      ? remembered.machine
      : (machines[0] ?? null);
  const wanted = form.directoryId ?? (usable ? remembered.directoryId : '');
  const directoryId =
    input.directoriesKnown === true && wanted !== '' && !directories.includes(wanted) ? '' : wanted;
  return { directoryId, machine, staleRemembered: remembered !== null && !usable };
}
