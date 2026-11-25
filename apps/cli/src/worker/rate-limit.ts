import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../domain/values.js';
import {
  USAGE_WINDOWS,
  readStoredUsage,
  usageFile,
  type StoredUsage,
  type UsageWindow,
} from '../dispatch/usage.js';
import type { StreamLine } from './stream.js';

const EVENT_NAMES: Record<UsageWindow, string> = { fiveHour: 'five_hour', sevenDay: 'seven_day' };

export interface WindowReading {
  readonly utilization: number;
  readonly resetsAt: Date;
}

export type RateLimitReading = Partial<Record<UsageWindow, WindowReading>>;

function windowReading(utilization: unknown, resetsAt: unknown): WindowReading | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0) {
    return undefined;
  }
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return undefined;
  }
  const date = new Date(resetsAt * 1000);
  return Number.isNaN(date.getTime()) ? undefined : { utilization, resetsAt: date };
}

export function rateLimitIn(event: StreamLine): RateLimitReading | undefined {
  if (event.type !== 'rate_limit_event') return undefined;
  const info = event.rate_limit_info;
  if (!isRecord(info)) return undefined;
  const reading: { -readonly [K in UsageWindow]?: WindowReading } = {};
  const windows = info.unifiedWindows;
  if (isRecord(windows)) {
    for (const window of USAGE_WINDOWS) {
      const entry = windows[EVENT_NAMES[window]];
      const found = isRecord(entry) ? windowReading(entry.utilization, entry.resetsAt) : undefined;
      if (found !== undefined) reading[window] = found;
    }
  } else {
    const window = USAGE_WINDOWS.find((name) => EVENT_NAMES[name] === info.rateLimitType);
    const utilization =
      info.utilization === undefined && info.status === 'rejected' ? 1 : info.utilization;
    const found = window === undefined ? undefined : windowReading(utilization, info.resetsAt);
    if (window !== undefined && found !== undefined) reading[window] = found;
  }
  return Object.keys(reading).length === 0 ? undefined : reading;
}

export function sameReading(a: RateLimitReading, b: RateLimitReading): boolean {
  return USAGE_WINDOWS.every((window) => {
    const x = a[window];
    const y = b[window];
    if (x === undefined || y === undefined) return x === y;
    return x.utilization === y.utilization && x.resetsAt.getTime() === y.resetsAt.getTime();
  });
}

export function recordUsage(stateDir: string, reading: RateLimitReading, seenAt: Date): void {
  const merged: { -readonly [K in UsageWindow]?: StoredUsage[K] } = {
    ...readStoredUsage(stateDir),
  };
  for (const window of USAGE_WINDOWS) {
    const found = reading[window];
    if (found !== undefined) {
      merged[window] = {
        utilization: found.utilization,
        resetsAt: found.resetsAt.toISOString(),
        seenAt: seenAt.toISOString(),
      };
    }
  }
  const file = usageFile(stateDir);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(merged)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
