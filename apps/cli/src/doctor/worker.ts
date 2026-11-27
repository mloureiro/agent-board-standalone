import type { DoctorResult } from '@rumo/contract';

import type { Context } from '../commands/context.js';
import { readTickResult } from '../dispatch/result.js';
import { now } from '../transport/clock.js';
import { isUnitPlatform } from '../units/recipe.js';
import { pass, problem } from './results.js';

const STALE_AFTER_MS = 15 * 60_000;

export function workerCheck(ctx: Context): DoctorResult {
  if (!isUnitPlatform(ctx.rt.platform)) {
    return pass(
      'worker',
      `not checked: a worker needs Linux or macOS, and this is ${ctx.rt.platform}`,
    );
  }
  const result = readTickResult(ctx.dirs.state);
  if (result === null) {
    return problem(
      'worker',
      'warn',
      'no dispatch tick has run yet',
      'run `rumo setup`, or `rumo internal dispatch` once',
    );
  }
  if (result.status !== 'ok') {
    return problem(
      'worker',
      'fail',
      `${result.status}: ${result.message}`,
      result.status === 'refused'
        ? 'issue a new machine token and run `rumo init --force`'
        : 'check that the board is reachable',
    );
  }
  const ageMs = now(ctx.rt.env) - Date.parse(result.at);
  if (ageMs > STALE_AFTER_MS) {
    return problem(
      'worker',
      'warn',
      `the last dispatch tick was ${Math.round(ageMs / 60_000)} minutes ago`,
      'check that the dispatch timer and the listener run: `rumo restart`',
    );
  }
  return pass('worker', `the last dispatch tick at ${result.at} succeeded`);
}
