const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function spanText(ms: number): string {
  if (ms < MINUTE) return 'under a minute';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

export const inText = (target: number, now: number): string | null =>
  target > now ? `in ${spanText(target - now)}` : null;

export const agoText = (at: number, now: number): string =>
  now - at < MINUTE ? 'just now' : `${spanText(now - at)} ago`;

export const parseTime = (value: string | null): number | null => {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};
