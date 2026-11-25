import { newWatchId, type WatchDef } from './store.js';
import { StreamBudget } from './stream-limit.js';
import { startStream, type StreamProcess } from './stream.js';
import { deliver, report, scanWatches, touchHeartbeat, type ScanDeps } from './scan.js';
import { publishWatches } from './publish.js';

export const SCAN_MS = 2_000;
export const STREAM_FLUSH_MS = 1_000;
export const WATCH_ATTEMPT_LIMIT_MS = 100_000;

export type StreamStarter = (command: string, cwd: string) => StreamProcess;

export interface WatchUnitDeps extends ScanDeps {
  readonly stateDir: string;
  readonly startStream?: StreamStarter;
}

interface Running {
  readonly def: WatchDef;
  readonly process: StreamProcess;
  readonly budget: StreamBudget;
  flushedAt: number;
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

function lastLines(text: string): string {
  return text.trim().split('\n').slice(-20).join('\n');
}

async function flush(
  deps: WatchUnitDeps,
  run: Running,
  key: string,
  running: Map<string, Running>,
) {
  const { store, now } = deps;
  const at = now().getTime();
  const ended = run.process.ended;
  const due = at - run.flushedAt >= STREAM_FLUSH_MS;
  const current = store.read(run.def.task, run.def.name);
  if (current === undefined || current.id !== run.def.id) {
    run.process.kill();
    running.delete(key);
    return;
  }
  if (!due && ended === null) return;
  const text = run.process.drain();
  if (text.trim() !== '') {
    run.flushedAt = at;
    if (run.budget.record(at, Buffer.byteLength(text)) === 'exceeded') {
      run.process.kill();
      running.delete(key);
      await report(deps, current, {
        kind: 'stopped',
        text: `the stream sent too much (more than the budget allows in ten minutes); the last of it:\n${lastLines(text)}`,
      });
      return;
    }
    if (current.source.kind === 'stream') {
      const counted: WatchDef = {
        ...current,
        source: { ...current.source, events: current.source.events + 1 },
        last: { at: now().toISOString(), summary: 'streaming' },
      };
      store.write(counted);
      const event = {
        id: newWatchId(),
        task: current.task,
        name: current.name,
        at: now().toISOString(),
        kind: 'event' as const,
        text: text.trim(),
      };
      store.writeEvent(event);
      await publishWatches(deps.s, store, current.task, deps.log);
      await deliver(deps, event);
    }
  }
  if (ended !== null) {
    running.delete(key);
    await report(deps, current, {
      kind: 'exit',
      text: `the command ended${ended.code === null ? '' : ` with exit code ${ended.code}`}`,
    });
  }
}

export async function runWatchUnit(
  deps: WatchUnitDeps,
  signal: AbortSignal,
  options: { readonly scanMs?: number } = {},
): Promise<void> {
  const running = new Map<string, Running>();
  const starter = deps.startStream ?? startStream;
  deps.log('watch unit started');
  while (!signal.aborted) {
    try {
      touchHeartbeat(deps.stateDir, deps.now());
      await scanWatches(deps, { timeLeftMs: WATCH_ATTEMPT_LIMIT_MS });
      for (const task of deps.store.tasks()) {
        for (const def of deps.store.list(task).defs) {
          if (def.source.kind !== 'stream') continue;
          const key = `${task}/${def.name}/${def.id}`;
          let run = running.get(key);
          if (run === undefined) {
            const { source } = def;
            const started: WatchDef = {
              ...def,
              source: { ...source, starts: source.starts + 1 },
              last: {
                at: deps.now().toISOString(),
                summary: source.starts === 0 ? 'started' : 'started again',
              },
            };
            deps.store.write(started);
            run = {
              def: started,
              process: starter(source.command, source.cwd),
              budget: new StreamBudget(),
              flushedAt: deps.now().getTime(),
            };
            running.set(key, run);
            deps.log(`STREAM ${task} ${def.name} started`);
          }
          await flush(deps, run, key, running);
        }
      }
      for (const [key, run] of [...running]) {
        const current = deps.store.read(run.def.task, run.def.name);
        if (current?.id === run.def.id) continue;
        run.process.kill();
        running.delete(key);
      }
    } catch (error) {
      deps.log(`WARN scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(options.scanMs ?? SCAN_MS, signal);
  }
  for (const run of running.values()) run.process.kill();
  deps.log('watch unit stopped');
}
