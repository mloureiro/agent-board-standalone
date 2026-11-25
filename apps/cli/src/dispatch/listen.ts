import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { machineEventsRoute } from '@agent-board/contract';

import { applyBoardAgents } from '../agents/shared.js';
import type { Context } from '../commands/context.js';
import { feedsOf, runFeed } from '../commands/feeds/run.js';
import { syncDirectories } from '../directories/sync.js';
import { EXIT, ReportedFailure } from '../errors.js';
import { readFeedState } from '../feeds/store.js';
import { ApiError } from '../transport/errors.js';
import { TransportError } from '../transport/request.js';
import { openSession, type Session } from '../transport/session.js';
import { STREAM_IDLE_MS, readSse } from '../transport/stream.js';
import { now as clockNow } from '../transport/clock.js';
import { TICK_GRACE_MS, TICK_LIMIT_MS } from './limits.js';
import { requireWorkerPlatform } from './run.js';
import { createRunRecords } from './run-record.js';
import { selfCommand } from './spawn.js';

export interface ListenOptions {
  readonly debounceMs: number;
  readonly retryMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly healthyMs: number;
  readonly dueFloorMs: number;
  readonly dueMaxMs: number;
  readonly feedScanMs: number;
  readonly idleMs: number;
  readonly runTick?: () => Promise<number>;
  readonly session?: Session;
}

export const LISTEN_DEFAULTS: Omit<ListenOptions, 'runTick' | 'session'> = {
  debounceMs: 1_000,
  retryMs: 5_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  healthyMs: 30_000,
  dueFloorMs: 5_000,
  dueMaxMs: 60 * 60_000,
  feedScanMs: 15_000,
  idleMs: STREAM_IDLE_MS,
};

const KILLED = 137;

export function runLimited(
  argv: readonly string[],
  limits: { limitMs: number; graceMs: number },
): Promise<number> {
  const [program = '', ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', detached: true });
    let stopped = false;
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
    };
    const limitTimer = setTimeout(() => {
      stopped = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killed = true;
        signalGroup('SIGKILL');
      }, limits.graceMs);
    }, limits.limitMs);
    child.once('error', (error) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(limitTimer);
      clearTimeout(killTimer);
      if (stopped) signalGroup('SIGKILL');
      if (killed) return resolve(KILLED);
      if (stopped) return resolve(EXIT.timedOut);
      resolve(code ?? (signal === null ? -1 : 128 + (osConstants.signals[signal] ?? 0)));
    });
  });
}

export function tickProcess(ctx: Context): () => Promise<number> {
  return () =>
    runLimited(selfCommand(ctx, 'internal', 'dispatch'), {
      limitMs: TICK_LIMIT_MS,
      graceMs: TICK_GRACE_MS,
    });
}

interface Ticker {
  now(): void;
  soon(): void;
  stop(): Promise<void>;
}

function createTicker(
  run: () => Promise<number>,
  nextDue: () => number | undefined,
  log: (line: string) => void,
  options: ListenOptions,
  clock: () => number,
): Ticker {
  let pending: NodeJS.Timeout | undefined;
  let due: NodeJS.Timeout | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  const clearPending = (): void => {
    clearTimeout(pending);
    pending = undefined;
  };
  const clearDue = (): void => {
    clearTimeout(due);
    due = undefined;
  };
  const armDue = (): void => {
    clearDue();
    const at = stopped ? undefined : nextDue();
    if (at === undefined) return;
    due = setTimeout(
      () => {
        due = undefined;
        const again = nextDue();
        if (again !== undefined && again > clock()) armDue();
        else tickNow();
      },
      Math.min(options.dueMaxMs, Math.max(options.dueFloorMs, at - clock())),
    );
  };
  const schedule = (ms: number): void => {
    clearPending();
    pending = setTimeout(() => {
      pending = undefined;
      current = tick();
    }, ms);
  };
  function tickNow(): void {
    if (running) dirty = true;
    else {
      clearPending();
      current = tick();
    }
  }
  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    dirty = false;
    clearDue();
    let code: number | undefined;
    try {
      code = await run();
    } catch (error) {
      log(`tick could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    running = false;
    if (code === EXIT.lockHeld) {
      log(`tick: another tick holds the lock, retrying in ${options.retryMs / 1000} s`);
      schedule(options.retryMs);
      return;
    }
    if (code === EXIT.timedOut || code === KILLED)
      log(`tick: stopped after its limit (exit ${code})`);
    else if (code !== undefined && code !== 0) log(`tick: exit ${code}`);
    if (dirty && !stopped) current = tick();
    else armDue();
  }
  return {
    now: tickNow,
    soon() {
      if (running) dirty = true;
      else if (pending === undefined) schedule(options.debounceMs);
    },
    async stop() {
      stopped = true;
      clearPending();
      clearDue();
      await current;
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function startup(ctx: Context, s: Session): Promise<void> {
  try {
    await syncDirectories(s, { configDir: ctx.dirs.config, say: ctx.out });
  } catch (error) {
    ctx.out(`WARN sending the directory list failed: ${errorText(error)}`);
  }
  try {
    await applyBoardAgents(s, ctx.dirs, ctx.out);
  } catch (error) {
    ctx.out(`WARN applying the board's agents failed: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function feedsLoop(
  ctx: Context,
  s: Session,
  options: ListenOptions,
  signal: AbortSignal,
): Promise<void> {
  const flying = new Set<string>();
  const scan = (): void => {
    const nowMs = clockNow(ctx.rt.env);
    for (const feed of feedsOf(ctx).feeds) {
      if (flying.has(feed.name)) continue;
      const state = readFeedState(ctx.dirs, feed.name);
      const last = state.last === null ? 0 : Date.parse(state.last.at);
      const asked = state.runRequestedAt !== undefined;
      if (state.paused && !asked) continue;
      if (!asked && nowMs - last < feed.everyMs) continue;
      flying.add(feed.name);
      void runFeed(ctx, s, feed)
        .then((run) => {
          ctx.out(
            `FEED ${feed.name} ${run.ok ? 'ran' : `failed: ${run.error ?? 'some items failed'}`}`,
          );
        })
        .catch((error: unknown) => {
          ctx.out(`WARN feed ${feed.name} failed: ${errorText(error)}`);
        })
        .finally(() => {
          flying.delete(feed.name);
        });
    }
  };
  return (async () => {
    while (!signal.aborted) {
      try {
        scan();
      } catch (error) {
        ctx.out(`WARN feeds not read: ${errorText(error)}`);
      }
      await sleep(options.feedScanMs, signal);
    }
  })();
}

async function openWithBackoff(
  ctx: Context,
  options: ListenOptions,
  signal: AbortSignal,
): Promise<Session | null> {
  if (options.session !== undefined) return options.session;
  let delay = options.backoffBaseMs;
  while (!signal.aborted) {
    try {
      return await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      ctx.out(`the server is not reachable (${error.message}); retrying in ${delay / 1000} s`);
      await sleep(delay, signal);
      delay = Math.min(options.backoffMaxMs, delay * 2);
    }
  }
  return null;
}

async function hold(
  s: Session,
  signal: AbortSignal,
  options: ListenOptions,
  onTasks: () => void,
  onConnect: () => void,
  log: (line: string) => void,
): Promise<void> {
  let delay = options.backoffBaseMs;
  while (!signal.aborted) {
    const connection = new AbortController();
    const stop = (): void => {
      connection.abort();
    };
    signal.addEventListener('abort', stop, { once: true });
    const startedAt = Date.now();
    let idle: NodeJS.Timeout | undefined;
    const rearm = (): void => {
      clearTimeout(idle);
      idle = setTimeout(stop, options.idleMs);
    };
    try {
      const response = await s.openEvents(machineEventsRoute.path, connection.signal);
      onConnect();
      rearm();
      if (response.body !== null) {
        for await (const message of readSse(response.body, connection.signal)) {
          rearm();
          if (message.event === 'tasks') onTasks();
        }
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        throw new ReportedFailure(EXIT.failure, 'the server no longer serves this machine token');
      }
      if (!signal.aborted && !connection.signal.aborted)
        log(`event stream lost: ${errorText(error)}`);
    } finally {
      clearTimeout(idle);
      signal.removeEventListener('abort', stop);
    }
    if (signal.aborted) return;
    if (Date.now() - startedAt >= options.healthyMs) delay = options.backoffBaseMs;
    await sleep(delay, signal);
    delay = Math.min(options.backoffMaxMs, delay * 2);
  }
}

export async function runListener(
  ctx: Context,
  given: Partial<ListenOptions> = {},
  signal: AbortSignal = ctx.rt.interrupt,
): Promise<void> {
  requireWorkerPlatform(ctx, 'listen');
  const options: ListenOptions = { ...LISTEN_DEFAULTS, ...given };
  const s = await openWithBackoff(ctx, options, signal);
  if (s === null) return;
  await startup(ctx, s);
  const records = createRunRecords(ctx.dirs.run);
  const ticker = createTicker(
    options.runTick ?? tickProcess(ctx),
    () => records.nextDue()?.getTime(),
    ctx.out,
    options,
    () => clockNow(ctx.rt.env),
  );
  const feedStop = new AbortController();
  const linkStop = (): void => {
    feedStop.abort();
  };
  signal.addEventListener('abort', linkStop, { once: true });
  const feeds = feedsLoop(ctx, s, options, feedStop.signal);
  try {
    await hold(
      s,
      signal,
      options,
      () => ticker.soon(),
      () => ticker.now(),
      ctx.out,
    );
  } finally {
    feedStop.abort();
    signal.removeEventListener('abort', linkStop);
    await ticker.stop();
    await feeds;
  }
  ctx.out('stopped');
}
