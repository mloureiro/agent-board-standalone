import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../domain/values.js';
import { writeAtomic } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';

export interface FeedCounts {
  readonly listed: number;
  readonly created: number;
  readonly requeued: number;
  readonly rescheduled: number;
  readonly closed: number;
  readonly failed: number;
}

export interface FeedRun {
  readonly at: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly counts: FeedCounts;
}

export interface FeedState {
  readonly paused: boolean;
  readonly last: FeedRun | null;
  readonly items: Readonly<Record<string, string>>;
}

const EMPTY: FeedState = { paused: false, last: null, items: {} };

const file = (dirs: ProfileDirs, name: string): string =>
  path.join(dirs.state, 'feeds', `${name}.json`);

export function readFeedState(dirs: ProfileDirs, name: string): FeedState {
  const target = file(dirs, name);
  if (!existsSync(target)) return EMPTY;
  try {
    const raw: unknown = JSON.parse(readFileSync(target, 'utf8'));
    if (!isRecord(raw)) return EMPTY;
    return {
      paused: raw.paused === true,
      last: isRecord(raw.last) ? (raw.last as unknown as FeedRun) : null,
      items: isRecord(raw.items) ? (raw.items as Record<string, string>) : {},
    };
  } catch {
    return EMPTY;
  }
}

export function writeFeedState(dirs: ProfileDirs, name: string, state: FeedState): void {
  mkdirSync(path.join(dirs.state, 'feeds'), { recursive: true, mode: 0o700 });
  writeAtomic(file(dirs, name), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export function discardFeedState(dirs: ProfileDirs, name: string): void {
  rmSync(file(dirs, name), { force: true });
}
