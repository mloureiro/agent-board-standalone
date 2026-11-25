import { UsageError } from '../errors.js';

const UNIT_MS = { w: 7 * 86_400_000, d: 86_400_000, h: 3_600_000, m: 60_000 } as const;
const UNITS = ['w', 'd', 'h', 'm'] as const;

export const MAX_WAIT_MS = 7 * 86_400_000;

const DURATION_FORMS =
  'a number and a unit (m, h, d, w), largest unit first, such as 30m, 2h, 1d or 1h30m';
const WHEN_FORMS =
  'an ISO date and time with an offset or Z (2027-01-01T12:00:00Z), without one for local time (2027-01-01T12:00), ' +
  'a date (2027-01-01, local midnight) or a time of day (09:30, the next one)';

export function parseDuration(text: string, allowSeconds = false): number {
  const trimmed = text.trim();
  if (allowSeconds) {
    const seconds = /^(\d{1,6})s$/.exec(trimmed);
    if (seconds !== null) return Number(seconds[1]) * 1000;
  }
  const match = /^(?:(\d+)w\s*)?(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?$/.exec(trimmed);
  if (match === null || trimmed === '') {
    throw new UsageError(`"${text.slice(0, 40)}" is not a duration; use ${DURATION_FORMS}`);
  }
  const ms = UNITS.reduce(
    (sum, unit, index) => sum + Number(match[index + 1] ?? 0) * UNIT_MS[unit],
    0,
  );
  if (ms <= 0) throw new UsageError(`a duration must be longer than zero; use ${DURATION_FORMS}`);
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 60_000) return `${Math.round(ms / 1000)}s`;
  let rest = Math.round(ms / 60_000) * 60_000;
  const parts = UNITS.flatMap((unit) => {
    const count = Math.floor(rest / UNIT_MS[unit]);
    rest -= count * UNIT_MS[unit];
    return count > 0 ? [`${count}${unit}`] : [];
  });
  return parts.length > 0 ? parts.join('') : '0m';
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, second);
  const exact =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute;
  return exact ? date : null;
}

function withOffset(input: string): Date | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(
      input,
    );
  if (match === null) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const stated = new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0),
  );
  const exact =
    stated.getUTCFullYear() === year &&
    stated.getUTCMonth() === (month ?? 1) - 1 &&
    stated.getUTCDate() === day &&
    stated.getUTCHours() === hour &&
    stated.getUTCMinutes() === minute;
  return exact ? date : null;
}

function withoutOffset(input: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(input);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return localDate(year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0, second ?? 0);
}

function timeOfDay(input: string, now: Date): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input);
  if (match === null) return null;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59) return null;
  const ahead = hour * 60 + minute > now.getHours() * 60 + now.getMinutes();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (ahead ? 0 : 1));
  return localDate(day.getFullYear(), day.getMonth() + 1, day.getDate(), hour, minute, 0);
}

export function parseWhen(text: string, now: Date): Date {
  const input = text.trim();
  const date = withOffset(input) ?? withoutOffset(input) ?? timeOfDay(input, now);
  if (date === null)
    throw new UsageError(`"${text.slice(0, 40)}" is not a time; use ${WHEN_FORMS}`);
  if (date.getTime() <= now.getTime())
    throw new UsageError(`"${text.slice(0, 40)}" is in the past`);
  return date;
}

export function parseStart(
  flags: { in?: string | undefined; at?: string | undefined },
  now: Date,
): Date | undefined {
  if (flags.in !== undefined) return new Date(now.getTime() + parseDuration(flags.in));
  return flags.at === undefined ? undefined : parseWhen(flags.at, now);
}

export function localTime(date: Date): string {
  return date.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}
