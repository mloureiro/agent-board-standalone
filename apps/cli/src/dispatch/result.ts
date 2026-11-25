import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord } from '../domain/values.js';
import { writeAtomic } from '../profile/files.js';

export const TICK_RESULT_FILE = 'dispatch-result.json';

export type TickStatus = 'ok' | 'refused' | 'error';

export interface TickResult {
  readonly at: string;
  readonly status: TickStatus;
  readonly message: string;
}

const STATUSES: readonly string[] = ['ok', 'refused', 'error'];

export function writeTickResult(stateDir: string, result: TickResult): void {
  writeAtomic(path.join(stateDir, TICK_RESULT_FILE), `${JSON.stringify(result)}\n`, 0o600);
}

export function readTickResult(stateDir: string): TickResult | null {
  const file = path.join(stateDir, TICK_RESULT_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      isRecord(raw) &&
      typeof raw.at === 'string' &&
      typeof raw.message === 'string' &&
      typeof raw.status === 'string' &&
      STATUSES.includes(raw.status)
    ) {
      return { at: raw.at, status: raw.status as TickStatus, message: raw.message };
    }
  } catch {
    return null;
  }
  return null;
}
