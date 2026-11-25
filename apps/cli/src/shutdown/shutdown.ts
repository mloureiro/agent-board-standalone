import type { ProcessOps, RunFiles } from './run-files.js';

export const DEFAULT_SHUTDOWN_GRACE_S = 20;
const POLL_MS = 250;
const REPORT_RESERVE_MS = 5_000;
export const PAUSE_SIGNAL: NodeJS.Signals = 'SIGUSR2';

export interface ShutdownDeps {
  readonly files: RunFiles;
  readonly processes: ProcessOps;
  readonly graceMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly print: (line: string) => void;
  readonly pollMs?: number;
}

type Outcome = 'paused' | 'stopped' | 'gone';

function liveWorkers(deps: ShutdownDeps): string[] {
  return deps.files.tasksWith('pid').filter((task) => {
    const pid = deps.files.pidOf(task, 'pid');
    return pid !== null && deps.processes.alive(pid);
  });
}

function killAgents(deps: ShutdownDeps, task: string): void {
  const group = deps.files.pidOf(task, 'pgid');
  if (group !== null) deps.processes.signal(-group, 'SIGKILL');
}

function stop(deps: ShutdownDeps, task: string): void {
  killAgents(deps, task);
  const pid = deps.files.pidOf(task, 'pid');
  if (pid !== null) deps.processes.signal(pid, 'SIGKILL');
  deps.files.clear(task);
}

export async function shutdownWorkers(deps: ShutdownDeps): Promise<Map<string, Outcome>> {
  const started = deps.now();
  const workerDeadline = new Date(
    started + deps.graceMs - Math.min(REPORT_RESERVE_MS, deps.graceMs / 2),
  );
  const results = new Map<string, Outcome>();
  const running = liveWorkers(deps);

  for (const task of deps.files.tasksWith('pgid')) {
    if (running.includes(task)) continue;
    killAgents(deps, task);
    deps.files.clear(task);
    results.set(task, 'stopped');
  }

  if (running.length > 0) {
    deps.print(`pausing ${running.length} running worker(s), up to ${deps.graceMs / 1000} s`);
  }
  for (const task of running) {
    const pid = deps.files.pidOf(task, 'pid');
    if (pid === null) {
      results.set(task, 'gone');
      continue;
    }
    deps.files.requestShutdown(task, workerDeadline);
    deps.processes.signal(pid, PAUSE_SIGNAL);
  }

  let remaining = running.filter((task) => !results.has(task));
  while (remaining.length > 0 && deps.now() - started < deps.graceMs) {
    await deps.sleep(deps.pollMs ?? POLL_MS);
    const live = new Set(liveWorkers(deps));
    remaining = remaining.filter((task) => live.has(task));
  }
  for (const task of running) {
    if (results.has(task)) continue;
    if (remaining.includes(task)) {
      stop(deps, task);
      results.set(task, 'stopped');
    } else {
      killAgents(deps, task);
      deps.files.clear(task);
      results.set(task, 'paused');
    }
  }
  for (const [task, outcome] of results) deps.print(`${task} ${outcome}`);
  if (results.size === 0) deps.print('no worker is running');
  return results;
}
