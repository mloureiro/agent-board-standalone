import { ApiError } from '../transport/errors.js';
import { STREAM_IDLE_MS, readSse } from '../transport/stream.js';
import type { OpenTask } from '../commands/tasks/open.js';
import { diffTasks, matchesFilter, type BoardEvent, type EventFilter } from './diff.js';
import type { OpenNote } from '../commands/tasks/open.js';

export interface EventsTiming {
  readonly debounceMs: number;
  readonly pollMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly idleMs: number;
}

export const EVENTS_TIMING: EventsTiming = {
  debounceMs: 300,
  pollMs: 10_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  idleMs: STREAM_IDLE_MS,
};

export interface EventsDeps {
  openStream(signal: AbortSignal): Promise<Response>;
  list(): Promise<OpenTask[]>;
  readNotes(id: string): Promise<OpenNote[]>;
  fetchLeft(id: string): Promise<OpenTask | null>;
  readonly filter: EventFilter;
  emit(event: BoardEvent): void;
  log(line: string): void;
  now(): Date;
  readonly signal: AbortSignal;
  readonly timing?: Partial<EventsTiming>;
}

const REFUSED = 'the board refused this machine token: it was revoked or is not valid';

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
    signal.addEventListener('abort', done);
  });
}

export async function runEvents(deps: EventsDeps): Promise<number> {
  const timing = { ...EVENTS_TIMING, ...deps.timing };
  const stopped = new AbortController();
  const onAbort = (): void => stopped.abort();
  if (deps.signal.aborted) return 0;
  deps.signal.addEventListener('abort', onAbort);

  let exitCode = 0;
  let snapshot: OpenTask[] | undefined;
  let running = false;
  let dirty = false;
  let failing = false;
  let announced = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const cancelTimers = (): void => {
    clearTimeout(debounce);
    clearTimeout(poll);
    debounce = undefined;
    poll = undefined;
  };

  const finish = (code: number): void => {
    exitCode = code;
    stopped.abort();
  };

  async function refresh(): Promise<void> {
    running = true;
    dirty = false;
    cancelTimers();
    try {
      const listed = await deps.list();
      const events =
        snapshot === undefined
          ? []
          : await diffTasks(snapshot, listed, {
              readNotes: deps.readNotes,
              fetchLeft: deps.fetchLeft,
              at: deps.now(),
            });
      snapshot = listed;
      if (failing) deps.log('the board can be read again');
      failing = false;
      if (!announced) {
        announced = true;
        deps.log('connected; reporting the changes from now on');
      }
      for (const event of events) if (matchesFilter(event, deps.filter)) deps.emit(event);
    } catch (error) {
      if (stopped.signal.aborted) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        deps.log(REFUSED);
        finish(1);
        return;
      }
      if (!failing) {
        deps.log(
          `cannot read the board: ${error instanceof Error ? error.message : String(error)}; trying again at the next change or in ${timing.pollMs / 1000} s`,
        );
      }
      failing = true;
    } finally {
      running = false;
      if (!stopped.signal.aborted) {
        if (dirty) current = refresh();
        else poll = setTimeout(requestNow, timing.pollMs);
      }
    }
  }

  function requestNow(): void {
    if (stopped.signal.aborted) return;
    if (running) dirty = true;
    else current = refresh();
  }

  function requestSoon(): void {
    if (stopped.signal.aborted) return;
    if (running) {
      dirty = true;
      return;
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      requestNow();
    }, timing.debounceMs);
  }

  async function hold(): Promise<void> {
    let failures = 0;
    while (!stopped.signal.aborted) {
      const attempt = new AbortController();
      const abortAttempt = (): void => attempt.abort();
      stopped.signal.addEventListener('abort', abortAttempt);
      let idle: ReturnType<typeof setTimeout> | undefined;
      const rearm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(abortAttempt, timing.idleMs);
      };
      try {
        rearm();
        const response = await deps.openStream(attempt.signal);
        failures = 0;
        requestNow();
        for await (const message of readSse(
          response.body as ReadableStream<Uint8Array>,
          attempt.signal,
        )) {
          rearm();
          if (message.event === 'tasks') requestSoon();
        }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          deps.log(REFUSED);
          finish(1);
        } else if (!stopped.signal.aborted && !attempt.signal.aborted) {
          deps.log(error instanceof Error ? error.message : String(error));
        }
      } finally {
        clearTimeout(idle);
        stopped.signal.removeEventListener('abort', abortAttempt);
      }
      if (stopped.signal.aborted) return;
      failures += 1;
      const delay = Math.min(timing.backoffBaseMs * 2 ** (failures - 1), timing.backoffMaxMs);
      deps.log(`the event stream closed; reconnecting in ${Math.round(delay / 1000)} s`);
      await sleep(delay, stopped.signal);
    }
  }

  try {
    await hold();
  } finally {
    deps.signal.removeEventListener('abort', onAbort);
    stopped.abort();
    cancelTimers();
    await current;
    cancelTimers();
  }
  return exitCode;
}
