import { setWatchesRoute } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import { formatDuration, localTime } from '../domain/time.js';
import { oneLine, plain } from '../domain/rules.js';
import type { Session } from '../transport/session.js';
import {
  MAX_TASK_WATCHES,
  MAX_WATCH_LABEL_CHARS,
  MAX_WATCH_STATUS_CHARS,
  isWatchId,
} from './shapes.js';
import type { WatchDef, WatchStore } from './store.js';

export interface TaskWatch {
  readonly id: string;
  readonly name: string;
  readonly kind: WatchDef['source']['kind'];
  readonly label: string;
  readonly status: string;
  readonly deadline: string;
  readonly lastAttemptAt?: string;
}

const prNumber = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

function labelOf(def: WatchDef): string {
  const { source } = def;
  switch (source.kind) {
    case 'timer':
      return 'timer';
    case 'command':
      return `command, every ${formatDuration(def.everyMs)}`;
    case 'stream':
      return 'stream';
    case 'pr-review':
      return `review #${prNumber(source.pr)}`;
    case 'pr-merged':
      return `merge of #${prNumber(source.pr)}`;
    case 'ci':
      return `CI #${prNumber(source.pr)}${source.required ? ' · required' : ''}`;
  }
}

function statusOf(def: WatchDef): string {
  const { source, last } = def;
  if (source.kind === 'timer') return `fires at ${localTime(new Date(def.deadline))}`;
  if (source.kind === 'stream') {
    return source.starts === 0 ? 'starting' : `streaming, ${source.events} events`;
  }
  if (last === undefined) return source.kind === 'command' ? 'not run yet' : 'not looked at yet';
  if (source.kind !== 'command') return plain(oneLine(last.summary, MAX_WATCH_STATUS_CHARS));
  return `${/^(exit \d+|too slow, stopped|killed)/.exec(last.summary)?.[1] ?? 'ran'} at ${localTime(new Date(last.at))}`;
}

export function taskWatchesOf(store: WatchStore, task: string): TaskWatch[] {
  return store
    .list(task)
    .defs.filter((def) => isWatchId(def.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_TASK_WATCHES)
    .map((def) => ({
      id: def.id,
      name: def.name,
      kind: def.source.kind,
      label: labelOf(def).slice(0, MAX_WATCH_LABEL_CHARS),
      status: statusOf(def),
      deadline: def.deadline,
      ...(def.last === undefined || def.source.kind === 'timer'
        ? {}
        : { lastAttemptAt: def.last.at }),
    }));
}

export function watchesDocument(store: WatchStore, task: string): string | null {
  const watches = taskWatchesOf(store, task);
  if (watches.length === 0) return null;
  return JSON.stringify({ watches, pendingEvents: store.events(task).length });
}

export async function publishWatches(
  session: Session,
  store: WatchStore,
  task: string,
  log: (line: string) => void,
): Promise<void> {
  if (session.dryRun || !session.supports('watches')) return;
  try {
    const document = watchesDocument(store, task);
    await session.command(setWatchesRoute, {
      id: task,
      watches:
        document === null ? null : await seal(session.keys, bindings.watches(task), document),
    });
  } catch (error) {
    log(
      `WARN publishing the watches of ${task} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
