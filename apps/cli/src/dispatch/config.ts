import type { Priority } from '@rumo/contract';

import { readConfigObject } from '../config/file.js';
import { isRecord } from '../domain/values.js';
import { autoUpdateMode, type AutoUpdateMode } from '../update/auto.js';

export interface Lane {
  readonly name: string;
  readonly slots: number;
  readonly default: boolean;
  readonly cwd?: string;
}

export interface UsageLimits {
  readonly fiveHour?: number;
  readonly sevenDay?: number;
  readonly priority: Priority;
}

export interface DispatchConfig {
  readonly machine: string | null;
  readonly lanes: readonly Lane[];
  readonly defaultCwd: string | null;
  readonly pauseAfterMinutes: number;
  readonly inactivityMinutes: number;
  readonly maxRunHours: number;
  readonly autoUpdate: AutoUpdateMode;
  readonly usageLimits: UsageLimits | null;
}

export const DEFAULT_LANES: readonly Lane[] = [{ name: 'general', slots: 3, default: true }];
export const DEFAULT_PAUSE_AFTER_MINUTES = 5;
export const DEFAULT_INACTIVITY_MINUTES = 15;
export const DEFAULT_MAX_RUN_HOURS = 6;

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function lanesOf(raw: unknown): readonly Lane[] {
  if (!isRecord(raw)) return DEFAULT_LANES;
  const entries = Object.entries(raw).flatMap(([name, entry]) =>
    isRecord(entry) ? [{ name, entry }] : [],
  );
  if (entries.length === 0) return DEFAULT_LANES;
  const marked = entries.find(({ entry }) => entry.default === true)?.name ?? entries[0]?.name;
  return entries.map(({ name, entry }) => ({
    name,
    slots: Math.max(1, Math.floor(positive(entry.slots, 1))),
    default: name === marked,
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
  }));
}

function limitsOf(raw: unknown): UsageLimits | null {
  if (!isRecord(raw)) return null;
  const priority = ['urgent', 'high', 'normal', 'low'].includes(raw.priority as string)
    ? (raw.priority as Priority)
    : 'urgent';
  return {
    priority,
    ...(typeof raw.fiveHour === 'number' ? { fiveHour: raw.fiveHour } : {}),
    ...(typeof raw.sevenDay === 'number' ? { sevenDay: raw.sevenDay } : {}),
  };
}

export function loadDispatchConfig(configDir: string): DispatchConfig {
  const raw = readConfigObject(configDir);
  return {
    machine: typeof raw.machine === 'string' ? raw.machine : null,
    lanes: lanesOf(raw.lanes),
    defaultCwd: typeof raw.defaultCwd === 'string' ? raw.defaultCwd : null,
    pauseAfterMinutes: positive(raw.pauseAfterMinutes, DEFAULT_PAUSE_AFTER_MINUTES),
    inactivityMinutes: positive(raw.inactivityMinutes, DEFAULT_INACTIVITY_MINUTES),
    maxRunHours: positive(raw.maxRunHours, DEFAULT_MAX_RUN_HOURS),
    autoUpdate: autoUpdateMode(raw.autoUpdate),
    usageLimits: limitsOf(raw.usageLimits),
  };
}

export function defaultLane(lanes: readonly Lane[]): Lane {
  return lanes.find((lane) => lane.default) ?? lanes[0] ?? (DEFAULT_LANES[0] as Lane);
}

export function ownLane(
  requested: string | null,
  lanes: readonly Lane[],
): { name: string; missing?: string } {
  if (requested === null) return { name: defaultLane(lanes).name };
  if (lanes.some((lane) => lane.name === requested)) return { name: requested };
  return { name: defaultLane(lanes).name, missing: requested };
}
