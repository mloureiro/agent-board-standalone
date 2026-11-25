import type { Claim, WatchDef, WatchEvent, WatchStore } from './store.js';
import { newWatchId } from './store.js';

export interface Report {
  readonly kind: WatchEvent['kind'];
  readonly text: string;
}

export function finishWatch(
  store: WatchStore,
  def: WatchDef,
  report: Report,
  now: Date,
): WatchEvent | undefined {
  const claim: Claim | undefined = store.claim(def.task, def.name, def.id);
  if (claim === undefined) return undefined;
  const event: WatchEvent = {
    id: newWatchId(),
    task: def.task,
    name: def.name,
    at: now.toISOString(),
    kind: report.kind,
    text: report.text,
  };
  try {
    store.writeEvent(event);
  } finally {
    claim.done();
  }
  return event;
}
