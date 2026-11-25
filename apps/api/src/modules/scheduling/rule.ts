import { MAX_INTERVAL_MS, MAX_SCHEDULE_CRONS, MIN_INTERVAL_MS } from '@agent-board/contract';
import { Cron } from 'croner';

import { ApiError } from '../../errors.js';
import type { ScheduleRow } from './types.js';

export type Rule = Pick<
  ScheduleRow,
  'everyMs' | 'cron' | 'moreCrons' | 'timezone' | 'anchorAt' | 'until'
>;

export interface RuleDraft {
  id: string;
  everyMs?: number | null | undefined;
  cron?: string | null | undefined;
  moreCrons?: readonly string[] | undefined;
  timezone?: string | null | undefined;
  after?: { scheduleId: string; delayMs?: number | undefined } | null | undefined;
}

const cronOf = (expression: string, timezone: string | null): Cron =>
  new Cron(expression, {
    ...(timezone === null ? {} : { timezone }),
    paused: true,
    mode: '5-part',
  });

const cronsOf = (rule: Pick<Rule, 'cron' | 'moreCrons'>): string[] =>
  rule.cron === null ? [] : [rule.cron, ...rule.moreCrons];

const nextOnGrid = (anchor: Date, everyMs: number, after: Date, inclusive: boolean): Date => {
  const steps = (after.getTime() - anchor.getTime()) / everyMs;
  const index = inclusive ? Math.ceil(steps) : Math.floor(steps) + 1;
  return new Date(anchor.getTime() + Math.max(index, 0) * everyMs);
};

const nextMatch = (rule: Rule, after: Date, inclusive: boolean): Date | null => {
  const from = inclusive ? new Date(after.getTime() - 1) : after;
  const matches = cronsOf(rule).flatMap(
    (expression) => cronOf(expression, rule.timezone).nextRun(from) ?? [],
  );
  return matches.reduce<Date | null>(
    (first, match) => (first === null || match < first ? match : first),
    null,
  );
};

export const nextOccurrence = (rule: Rule, after: Date, inclusive: boolean): Date | null => {
  const next =
    rule.everyMs === null
      ? nextMatch(rule, after, inclusive)
      : nextOnGrid(rule.anchorAt, rule.everyMs, after, inclusive);
  if (next === null || Number.isNaN(next.getTime())) return null;
  return rule.until !== null && next.getTime() > rule.until.getTime() ? null : next;
};

const requireCron = (expression: string, timezone: string): void => {
  const shown = expression.slice(0, 80);
  if (expression.trim().split(/\s+/).length !== 5)
    throw new ApiError(
      'bad-request',
      `"${shown}" is not a 5-field cron expression (minute hour day month weekday)`,
    );
  try {
    cronOf(expression, timezone);
  } catch (error) {
    throw new ApiError(
      'bad-request',
      `"${shown}" is not a cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const requireRule = (draft: RuleDraft): void => {
  if (draft.after != null) {
    if (draft.after.scheduleId === draft.id)
      throw new ApiError('bad-request', 'a schedule cannot run after itself');
    return;
  }
  if (draft.everyMs != null) {
    if (draft.everyMs < MIN_INTERVAL_MS || draft.everyMs > MAX_INTERVAL_MS)
      throw new ApiError('bad-request', 'an interval is from 1 minute to 10 years');
    return;
  }
  const timezone = draft.timezone ?? '';
  const crons = [draft.cron ?? '', ...(draft.moreCrons ?? [])];
  if (crons.length > MAX_SCHEDULE_CRONS)
    throw new ApiError(
      'bad-request',
      `a schedule has at most ${MAX_SCHEDULE_CRONS} cron expressions`,
    );
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new ApiError('bad-request', `"${timezone.slice(0, 60)}" is not a time zone`);
  }
  for (const expression of crons) requireCron(expression, timezone);
  const normalized = crons.map((expression) => expression.trim().split(/\s+/).join(' '));
  const repeated = normalized.find((expression, index) => normalized.indexOf(expression) !== index);
  if (repeated !== undefined)
    throw new ApiError(
      'bad-request',
      `the cron expression "${repeated.slice(0, 80)}" is given twice`,
    );
};
