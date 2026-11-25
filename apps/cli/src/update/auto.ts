import { AUTO_UPDATES } from '../config/schema.js';
import { now } from '../transport/clock.js';
import type { Verdict } from '../transport/compatibility.js';
import { checkForUpdate, compiledBinary, installRelease, type UpdateEnv } from './apply.js';
import { readPendingMigration } from './migrations.js';
import { RETRY_AFTER_FAILURE_MS, patchUpdateState, readUpdateState } from './state.js';

export type AutoUpdateMode = (typeof AUTO_UPDATES)[number];
export const DEFAULT_AUTO_UPDATE: AutoUpdateMode = 'incompatible';

export type AutoUpdateOutcome =
  | 'updated'
  | 'current'
  | 'off'
  | 'held'
  | 'pending-migration'
  | 'not-needed'
  | 'retry-later'
  | 'not-installable'
  | 'failed';

export function autoUpdateMode(value: unknown): AutoUpdateMode {
  return (AUTO_UPDATES as readonly unknown[]).includes(value)
    ? (value as AutoUpdateMode)
    : DEFAULT_AUTO_UPDATE;
}

export async function runAutoUpdate(
  env: UpdateEnv,
  mode: AutoUpdateMode,
  verdict: Verdict | null,
): Promise<AutoUpdateOutcome> {
  if (mode === 'never') return 'off';
  const state = readUpdateState(env.dirs.state);
  if (state.held !== undefined) return 'held';
  if (readPendingMigration(env.dirs.state) !== null) return 'pending-migration';
  if (mode === 'incompatible' && verdict !== 'client-too-old') return 'not-needed';
  if (state.failedAt !== undefined && now(env.rt.env) - state.failedAt < RETRY_AFTER_FAILURE_MS) {
    return 'retry-later';
  }
  if (compiledBinary(env.rt) === null) return 'not-installable';
  try {
    const { release, newer } = await checkForUpdate(env);
    if (release === null || !newer) return 'current';
    await installRelease(env, release);
    return 'updated';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    env.out(`auto-update failed: ${reason}`);
    patchUpdateState(env.dirs.state, (current) => ({ ...current, failedAt: now(env.rt.env) }));
    return 'failed';
  }
}
