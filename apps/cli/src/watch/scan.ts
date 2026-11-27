import { statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { getTaskRoute } from '@rumo/contract';

import { ApiError } from '../transport/errors.js';
import type { ExecOptions, ExecResult } from '../runtime.js';
import type { Session } from '../transport/session.js';
import { finishWatch, type Report } from './finish.js';
import { lookAtPr } from './pr.js';
import { publishWatches } from './publish.js';
import { isPolled, type Outcome } from './poll.js';
import type { WatchDef, WatchEvent, WatchStore } from './store.js';
import { eventText, noteTask, wakeTask } from './wake.js';

export const WATCH_HEARTBEAT_FILE = 'watch.heartbeat';
export const WATCH_HEARTBEAT_STALE_MS = 30_000;
export const COMMAND_OUTPUT_BYTES = 64 * 1024;
export const COMMAND_LIMIT_MS = 60_000;
export const OUTPUT_KEPT_CHARS = 2_000;

export type Exec = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<ExecResult>;

export interface ScanDeps {
  readonly s: Session;
  readonly store: WatchStore;
  readonly dryRun: boolean;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly exec: Exec;
  readonly isAlive: (task: string) => boolean;
}

export function touchHeartbeat(stateDir: string, at: Date): void {
  const file = path.join(stateDir, WATCH_HEARTBEAT_FILE);
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  utimesSync(file, at, at);
}

export function watchHeartbeatFresh(stateDir: string, nowMs: number): boolean {
  try {
    return (
      nowMs - statSync(path.join(stateDir, WATCH_HEARTBEAT_FILE)).mtimeMs < WATCH_HEARTBEAT_STALE_MS
    );
  } catch {
    return false;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_KEPT_CHARS ? trimmed.slice(-OUTPUT_KEPT_CHARS) : trimmed;
}

async function runCommand(
  deps: ScanDeps,
  def: WatchDef,
  command: string,
  cwd: string,
): Promise<Outcome> {
  try {
    const result = await deps.exec('sh', ['-c', command], {
      cwd,
      timeoutMs: Math.min(COMMAND_LIMIT_MS, Math.max(def.everyMs, 1_000)),
      maxBytes: COMMAND_OUTPUT_BYTES,
    });
    if (result.code === 0) return { kind: 'event', text: tail(result.stdout) };
    return { kind: 'pending', summary: `exit ${result.code}` };
  } catch {
    return { kind: 'pending', summary: 'too slow, stopped' };
  }
}

async function look(deps: ScanDeps, def: WatchDef): Promise<Outcome> {
  const { source } = def;
  if (source.kind === 'command') return runCommand(deps, def, source.command, source.cwd);
  if (source.kind === 'ci' || source.kind === 'pr-review' || source.kind === 'pr-merged') {
    return lookAtPr(deps.exec, def, source);
  }
  return { kind: 'pending', summary: 'waiting' };
}

export function deadlineReport(def: WatchDef): Report {
  if (def.source.kind === 'timer') return { kind: 'event', text: 'the timer ended' };
  return {
    kind: 'timeout',
    text: def.last === undefined ? 'it never ran' : `its last look: ${def.last.summary}`,
  };
}

export async function deliver(deps: ScanDeps, event: WatchEvent): Promise<void> {
  const { s, store } = deps;
  let task;
  try {
    task = await s.query(getTaskRoute, { id: event.task });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      store.removeEvents(event.task, [event.id]);
      return;
    }
    throw error;
  }
  if (task.closed || task.status === 'done') {
    store.removeEvents(event.task, [event.id]);
    return;
  }
  if (task.status === 'running') return;
  if (task.status === 'waiting' && task.machine === s.machine) {
    if (await wakeTask(s, event.task, eventText(event))) store.removeEvents(event.task, [event.id]);
    return;
  }
  await noteTask(s, event.task, eventText(event));
  store.removeEvents(event.task, [event.id]);
}

export async function report(deps: ScanDeps, def: WatchDef, outcome: Report): Promise<void> {
  const event = finishWatch(deps.store, def, outcome, deps.now());
  if (event === undefined) return;
  deps.log(`WATCH ${def.task} ${def.name} ${outcome.kind}`);
  await publishWatches(deps.s, deps.store, def.task, deps.log);
  await deliver(deps, event);
}

async function visit(deps: ScanDeps, def: WatchDef, nowMs: number): Promise<void> {
  if (nowMs >= Date.parse(def.deadline)) {
    await report(deps, def, deadlineReport(def));
    return;
  }
  if (!isPolled(def)) return;
  const last = def.last === undefined ? Date.parse(def.createdAt) : Date.parse(def.last.at);
  if (def.last !== undefined && nowMs - last < def.everyMs) return;
  const outcome = await look(deps, def);
  if (outcome.kind === 'event') {
    await report(deps, def, { kind: 'event', text: outcome.text });
    return;
  }
  if (deps.store.read(def.task, def.name)?.id !== def.id) return;
  deps.store.write({ ...def, last: { at: deps.now().toISOString(), summary: outcome.summary } });
}

export async function deliverPending(deps: ScanDeps): Promise<void> {
  for (const task of deps.store.tasks()) {
    if (deps.isAlive(task)) continue;
    for (const event of deps.store.events(task)) {
      await deliver(deps, event);
    }
  }
}

export async function scanWatches(
  deps: ScanDeps,
  options: { readonly timeLeftMs: number },
): Promise<void> {
  if (deps.dryRun) return;
  const deadline = deps.now().getTime() + options.timeLeftMs;
  for (const task of deps.store.tasks()) {
    for (const def of deps.store.list(task).defs) {
      if (deps.now().getTime() >= deadline) return;
      try {
        await visit(deps, def, deps.now().getTime());
      } catch (error) {
        deps.log(
          `WARN ${task}/${def.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  await deliverPending(deps);
}
