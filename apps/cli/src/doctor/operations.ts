import type { DoctorResult } from '@rumo/contract';

import type { Context } from '../commands/context.js';
import { readConfigObject } from '../config/file.js';
import { autoUpdateMode } from '../update/auto.js';
import { readPendingMigration } from '../update/migrations.js';
import { readUpdateState } from '../update/state.js';
import { pass, problem } from './results.js';

export function migrationCheck(ctx: Context): DoctorResult {
  const pending = readPendingMigration(ctx.dirs.state);
  if (pending === null) return pass('migration', 'no local migration is pending');
  const stopped =
    pending.failed === undefined
      ? 'it has not finished'
      : `step ${pending.failed.id} stopped: ${pending.failed.message}`;
  return problem(
    'migration',
    'fail',
    `a local migration from ${pending.from} to ${pending.to} is pending, ${stopped}; the dispatch tick claims nothing until it ends`,
    'run `rumo self-update --resume`, or `rumo self-update --rollback` to go back',
  );
}

export function autoUpdateCheck(ctx: Context): DoctorResult {
  let configured: unknown;
  try {
    configured = readConfigObject(ctx.dirs.config).autoUpdate;
  } catch {
    configured = undefined;
  }
  const mode = autoUpdateMode(configured);
  const state = readUpdateState(ctx.dirs.state);
  if (state.held !== undefined) {
    return problem(
      'auto-update',
      'warn',
      `auto-update (${mode}) is held since a rollback from ${state.held.version}`,
      'run `rumo self-update` to install the newest release and lift the hold',
    );
  }
  if (state.failedAt !== undefined) {
    return problem(
      'auto-update',
      'warn',
      `auto-update (${mode}) failed at ${new Date(state.failedAt).toISOString()} and retries one hour later`,
      'run `rumo self-update` to see the reason',
    );
  }
  return pass('auto-update', `auto-update is ${mode}`);
}
