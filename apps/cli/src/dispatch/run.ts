import type { Context } from '../commands/context.js';
import { CliError, EXIT, ReportedFailure } from '../errors.js';
import { createRunFiles, systemProcessOps, type ProcessOps } from '../shutdown/index.js';
import { openSession, type Session } from '../transport/session.js';
import { ClientTooOldError } from '../transport/compatibility.js';
import { ApiError } from '../transport/errors.js';
import { now as clockNow } from '../transport/clock.js';
import { runAutoUpdate } from '../update/auto.js';
import { compareVersions } from '../update/release-source.js';
import { PART_VERSION } from '../version.js';
import { migrationPending } from '../update/migrations.js';
import { isUnitPlatform } from '../units/recipe.js';
import { loadDispatchConfig } from './config.js';
import type { TickEnv } from './env.js';
import { TICK_GRACE_MS, TICK_LIMIT_MS } from './limits.js';
import { acquireTickLock } from './lock.js';
import { writeTickResult, type TickResult } from './result.js';
import { createRunRecords } from './run-record.js';
import { startWorker } from './spawn.js';
import { workerAlive } from './sweep.js';
import { runTick } from './tick.js';

export interface DispatchOptions {
  readonly limitMs?: number;
  readonly hardStopMs?: number;
  readonly processes?: ProcessOps;
  readonly start?: TickEnv['start'];
  readonly session?: Session;
  readonly hardExit?: (code: number) => void;
}

export function requireWorkerPlatform(ctx: Context, command: string): void {
  if (ctx.inRun) throw new CliError(`\`board internal ${command}\` cannot run inside a board run`);
  if (!isUnitPlatform(ctx.rt.platform)) {
    throw new CliError(
      `board internal ${command} needs Linux or macOS; this is ${ctx.rt.platform}`,
    );
  }
}

async function guarded<T>(
  work: () => Promise<T>,
  limitMs: number,
  hardStopMs: number,
  hardExit: (code: number) => void,
  say: (line: string) => void,
): Promise<T> {
  let limit: NodeJS.Timeout | undefined;
  let hard: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    limit = setTimeout(() => {
      say(`tick stopped after ${limitMs / 1000} s`);
      hard = setTimeout(() => {
        hardExit(EXIT.timedOut);
      }, hardStopMs);
      hard.unref();
      reject(new ReportedFailure(EXIT.timedOut));
    }, limitMs);
    limit.unref();
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(limit);
    clearTimeout(hard);
  }
}

function isNewer(advertised: string): boolean {
  try {
    return compareVersions(advertised, PART_VERSION) > 0;
  } catch {
    return false;
  }
}

async function openOrUpdate(ctx: Context, options: DispatchOptions): Promise<Session | null> {
  if (options.session !== undefined) return options.session;
  try {
    return await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun });
  } catch (error) {
    if (!(error instanceof ClientTooOldError)) throw error;
    const mode = loadDispatchConfig(ctx.dirs.config).autoUpdate;
    const outcome = await runAutoUpdate(
      { rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun, out: ctx.out },
      mode,
      'client-too-old',
    );
    if (outcome === 'updated') return null;
    throw error;
  }
}

class RefusedError extends CliError {}

function record(ctx: Context, status: TickResult['status'], message: string): void {
  if (ctx.dryRun) return;
  writeTickResult(ctx.dirs.state, {
    at: new Date(clockNow(ctx.rt.env)).toISOString(),
    status,
    message,
  });
}

function outcomeOf(error: unknown): { status: TickResult['status']; message: string } {
  if (error instanceof RefusedError) return { status: 'refused', message: error.message };
  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    return { status: 'refused', message: error.message };
  }
  if (error instanceof ReportedFailure && error.exitCode === EXIT.timedOut) {
    return { status: 'error', message: 'the tick passed its time limit' };
  }
  return { status: 'error', message: error instanceof Error ? error.message : String(error) };
}

export async function runDispatch(ctx: Context, options: DispatchOptions = {}): Promise<void> {
  requireWorkerPlatform(ctx, 'dispatch');
  const lock = acquireTickLock(ctx.dirs.run, clockNow(ctx.rt.env));
  if (lock === null) {
    ctx.out('another dispatch tick holds the lock');
    throw new ReportedFailure(EXIT.lockHeld);
  }
  try {
    await guarded(
      async () => {
        if (migrationPending(ctx.dirs.state)) {
          ctx.out('MIGRATION a migration is pending: nothing is claimed until it is finished');
          return;
        }
        const s = await openOrUpdate(ctx, options);
        if (s === null) {
          ctx.out('UPDATE the CLI was updated; the next tick runs the new version');
          return;
        }
        const config = loadDispatchConfig(ctx.dirs.config);
        if (config.machine !== null && s.machine !== config.machine) {
          throw new RefusedError(
            `this token belongs to machine ${s.machine}, but the profile is machine ${config.machine}`,
          );
        }
        const env: TickEnv = {
          ctx,
          s,
          config,
          records: createRunRecords(ctx.dirs.run),
          files: createRunFiles(ctx.dirs.run),
          processes: options.processes ?? systemProcessOps,
          now: () => new Date(clockNow(ctx.rt.env)),
          log: ctx.out,
          start: options.start ?? ((task) => startWorker(ctx, task)),
        };
        const advertised = s.info.advertisedCli;
        if (config.autoUpdate === 'always' && advertised !== null && isNewer(advertised)) {
          const busy = env.records.tasks().some((task) => workerAlive(env, task));
          if (busy) ctx.out('UPDATE-WAIT a worker is running; the update waits for the next tick');
          else {
            const outcome = await runAutoUpdate(
              { rt: ctx.rt, dirs: ctx.dirs, dryRun: ctx.dryRun, out: ctx.out },
              'always',
              'compatible',
            );
            if (outcome === 'updated') return;
          }
        }
        await runTick(env);
      },
      options.limitMs ?? TICK_LIMIT_MS,
      options.hardStopMs ?? TICK_GRACE_MS,
      options.hardExit ?? ((code) => process.exit(code)),
      ctx.out,
    );
    record(ctx, 'ok', 'the tick ran');
  } catch (error) {
    const { status, message } = outcomeOf(error);
    record(ctx, status, message);
    throw error;
  } finally {
    lock.release();
  }
}
