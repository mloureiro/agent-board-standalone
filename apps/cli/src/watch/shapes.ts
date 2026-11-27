import { watchId } from '@rumo/contract';

import { isPrUrl } from '../domain/rules.js';

export { isPrUrl };

export const MAX_TASK_WATCHES = 32;
export const MAX_COMMAND_CHARS = 8000;
export const MIN_COMMAND_EVERY_MS = 15_000;
export const CI_EVERY_MS = 30_000;
export const PR_REVIEW_EVERY_MS = 60_000;
export const PR_MERGED_EVERY_MS = 60_000;
export const MAX_IGNORE_PATTERNS = 20;
export const MAX_IGNORE_CHARS = 100;
export const MAX_WATCH_LABEL_CHARS = 120;
export const MAX_WATCH_STATUS_CHARS = 200;
export const WAIT_WATCH_NAME = 'wait';

const WATCH_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isWatchName(name: string): boolean {
  return WATCH_NAME.test(name);
}

export function isWatchId(value: string): boolean {
  return watchId.safeParse(value).success;
}

export function isIgnorePattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_IGNORE_CHARS && !/\p{Cc}/u.test(pattern);
}
