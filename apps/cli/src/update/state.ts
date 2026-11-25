import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeAtomic } from '../profile/files.js';

export const UPDATE_STATE_FILE = 'update.json';
export const RETRY_AFTER_FAILURE_MS = 60 * 60_000;
export const HINT_EVERY_MS = 24 * 60 * 60_000;

export interface UpdateState {
  readonly latest?: string;
  readonly checkedAt?: number;
  readonly failedAt?: number;
  readonly hintShownAt?: number;
  readonly held?: { readonly version: string; readonly at: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readUpdateState(stateDir: string): UpdateState {
  const file = path.join(stateDir, UPDATE_STATE_FILE);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const { held, latest } = parsed;
  const checkedAt = time(parsed.checkedAt);
  const failedAt = time(parsed.failedAt);
  const hintShownAt = time(parsed.hintShownAt);
  const heldAt = isRecord(held) ? time(held.at) : undefined;
  return {
    ...(typeof latest === 'string' ? { latest } : {}),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(hintShownAt === undefined ? {} : { hintShownAt }),
    ...(isRecord(held) && typeof held.version === 'string' && heldAt !== undefined
      ? { held: { version: held.version, at: heldAt } }
      : {}),
  };
}

export function writeUpdateState(stateDir: string, next: UpdateState): void {
  writeAtomic(path.join(stateDir, UPDATE_STATE_FILE), `${JSON.stringify(next, null, 2)}\n`, 0o600);
}

export function patchUpdateState(
  stateDir: string,
  change: (current: UpdateState) => UpdateState,
): UpdateState {
  const next = change(readUpdateState(stateDir));
  writeUpdateState(stateDir, next);
  return next;
}
