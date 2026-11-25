import type { Context } from '../commands/context.js';
import { requireWorkerPlatform } from '../dispatch/run.js';
import { createRunRecords } from '../dispatch/run-record.js';
import { workerAlive } from '../dispatch/sweep.js';
import { createRunFiles, systemProcessOps } from '../shutdown/index.js';
import { now as clockNow } from '../transport/clock.js';
import { TransportError } from '../transport/request.js';
import { openSession, type Session } from '../transport/session.js';
import { runWatchUnit } from './run.js';
import { WatchStore } from './store.js';

const RECONNECT_MS = 5_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function connect(ctx: Context, signal: AbortSignal): Promise<Session | null> {
  while (!signal.aborted) {
    try {
      return await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      ctx.out(`the server is not reachable (${error.message}); retrying`);
      await wait(RECONNECT_MS, signal);
    }
  }
  return null;
}

export async function runWatchCommand(
  ctx: Context,
  signal: AbortSignal = ctx.rt.interrupt,
  scanMs?: number,
): Promise<void> {
  requireWorkerPlatform(ctx, 'watch');
  const s = await connect(ctx, signal);
  if (s === null) return;
  const records = createRunRecords(ctx.dirs.run);
  const files = createRunFiles(ctx.dirs.run);
  const now = (): Date => new Date(clockNow(ctx.rt.env));
  const alive = (task: string): boolean =>
    workerAlive({ records, files, processes: systemProcessOps, now }, task);
  await runWatchUnit(
    {
      s,
      store: new WatchStore(ctx.dirs.state),
      dryRun: false,
      now,
      log: ctx.out,
      exec: (file, args, options) => ctx.rt.exec(file, args, options),
      isAlive: alive,
      stateDir: ctx.dirs.state,
    },
    signal,
    scanMs === undefined ? {} : { scanMs },
  );
}
