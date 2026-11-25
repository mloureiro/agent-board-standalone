import { formatDuration } from '../domain/time.js';

export interface RepeatShape {
  readonly everyMs: number | null;
  readonly crons: readonly string[];
  readonly after: { readonly scheduleId: string; readonly delayMs: number } | null;
}

export function describeRepeat(shape: RepeatShape): string {
  if (shape.everyMs !== null) return `every ${formatDuration(shape.everyMs)}`;
  if (shape.crons.length > 0) return `cron ${shape.crons.map((cron) => `"${cron}"`).join(', ')}`;
  if (shape.after !== null) {
    return `after ${shape.after.scheduleId}${
      shape.after.delayMs > 0 ? `, ${formatDuration(shape.after.delayMs)} later` : ''
    }`;
  }
  return 'no repeat';
}
