import type { WatchDef } from './store.js';

export type Outcome =
  | { readonly kind: 'event'; readonly text: string }
  | { readonly kind: 'pending'; readonly summary: string };

const POLLED = new Set<WatchDef['source']['kind']>(['command', 'ci', 'pr-review', 'pr-merged']);

export function isPolled(def: WatchDef): boolean {
  return POLLED.has(def.source.kind);
}
