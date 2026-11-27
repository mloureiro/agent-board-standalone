import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PRIORITIES, setUsageRoute, type Priority } from '@rumo/contract';
import { bindings, blindIndex, seal } from '@rumo/sealing';

import { isRecord } from '../domain/values.js';
import type { Session } from '../transport/session.js';
import type { UsageLimits } from './config.js';

export const USAGE_WINDOWS = ['fiveHour', 'sevenDay'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const WINDOW_LABELS: Record<UsageWindow, string> = {
  fiveHour: '5-hour',
  sevenDay: '7-day',
};

export interface StoredWindow {
  readonly utilization: number;
  readonly resetsAt: string;
  readonly seenAt: string;
}

export type StoredUsage = Partial<Record<UsageWindow, StoredWindow>>;

export interface ReachedWindow {
  readonly window: UsageWindow;
  readonly percent: number;
  readonly threshold: number;
  readonly resetsAt: Date;
}

const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_USAGE_TASKS = 200;

export const usageFile = (stateDir: string): string => path.join(stateDir, 'usage.json');

function isTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function readStoredUsage(stateDir: string): StoredUsage {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(usageFile(stateDir), 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(raw)) return {};
  const usage: StoredUsage = {};
  for (const window of USAGE_WINDOWS) {
    const entry = raw[window];
    if (!isRecord(entry)) continue;
    const { utilization, resetsAt, seenAt } = entry;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0)
      continue;
    if (isTime(resetsAt) && isTime(seenAt)) usage[window] = { utilization, resetsAt, seenAt };
  }
  return usage;
}

export function reachedWindows(input: {
  readonly limits: UsageLimits;
  readonly usage: StoredUsage;
  readonly now: Date;
}): ReachedWindow[] {
  return USAGE_WINDOWS.flatMap((window) => {
    const threshold = input.limits[window];
    const stored = input.usage[window];
    if (threshold === undefined || stored === undefined) return [];
    const resetsAt = new Date(stored.resetsAt);
    const ahead = resetsAt.getTime() - input.now.getTime();
    if (ahead <= 0 || ahead > MAX_RESET_AHEAD_MS) return [];
    const percent = Math.round(stored.utilization * 100 * 1e6) / 1e6;
    return percent >= threshold
      ? [{ window, percent: Math.round(percent), threshold, resetsAt }]
      : [];
  });
}

export function isBelowPriority(priority: Priority, lowest: Priority): boolean {
  return PRIORITIES.indexOf(priority) > PRIORITIES.indexOf(lowest);
}

export function describeReached(reached: readonly ReachedWindow[]): string {
  return reached
    .map(
      ({ window, percent, threshold, resetsAt }) =>
        `${WINDOW_LABELS[window]} usage ${percent}% (limit ${threshold}%, resets ${resetsAt.toISOString()})`,
    )
    .join('; ');
}

export function earliestReset(reached: readonly ReachedWindow[]): Date | undefined {
  return reached.reduce<Date | undefined>(
    (first, { resetsAt }) => (first === undefined || resetsAt < first ? resetsAt : first),
    undefined,
  );
}

function ids(values: readonly string[]): string[] {
  return [...new Set(values)].sort().slice(0, MAX_USAGE_TASKS);
}

export interface UsageStatus {
  readonly limits: UsageLimits | null;
  readonly stored: StoredUsage;
  readonly reached: readonly ReachedWindow[];
  readonly held: readonly string[];
  readonly open: readonly string[];
}

export function usageDocument(status: UsageStatus): string {
  const windows: Record<string, { percent: number; resetsAt: string; seenAt: string }> = {};
  for (const name of USAGE_WINDOWS) {
    const reading = status.stored[name];
    if (reading === undefined) continue;
    windows[name] = {
      percent: Math.min(1000, Math.round(Math.round(reading.utilization * 100 * 1e6) / 1e6)),
      resetsAt: reading.resetsAt,
      seenAt: reading.seenAt,
    };
  }
  const held = ids(status.held);
  const open = ids(status.open);
  return JSON.stringify({
    ...Object.fromEntries(
      USAGE_WINDOWS.flatMap((name) => {
        const reading = windows[name];
        return reading === undefined ? [] : [[`${name}Percent`, reading.percent]];
      }),
    ),
    held: held.length,
    open: open.length,
    ...(status.limits === null ? {} : { limits: status.limits }),
    windows,
    reached: status.reached.map(({ window }) => window),
    heldTasks: held,
    openTasks: open,
  });
}

export async function sendUsage(s: Session, status: UsageStatus): Promise<boolean> {
  if (s.dryRun) return false;
  const document = usageDocument(status);
  const index = await blindIndex(s.keys, `usage:${s.machine}:${document}`);
  if (index === s.info.usageIndex) return false;
  await s.command(setUsageRoute, {
    usage: await seal(s.keys, bindings.machineDocument('machine.usage', s.machine), document),
    index,
  });
  return true;
}
